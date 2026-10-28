// Run: node --test delivery.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Database = require('better-sqlite3');
const createApprovalDb = require('./approvalDb');
const { createDelivery, createAckWaiter } = require('./delivery');

const GROUP = '120363041234567890@g.us';
const CLIENT = '60111111111@c.us';
const sample = (o = {}) => ({
  clientJid: CLIENT, name: 'Ahmad Faiz', carReg: 'WXY1234',
  start: '2026-11-01', end: '2026-11-30', justification: 'Night shift duty', ...o,
});

function harness({ failSend = 0, failLetter = false, ack = async () => {}, groupId = GROUP } = {}) {
  const db = new Database(':memory:');
  const approvals = createApprovalDb(db);
  const out = [], errors = [];
  let sendFailures = failSend, n = 0;
  const msg = () => ({ id: { _serialized: `m${++n}` }, ack: 1 });
  const maybeFail = to => { if (to !== GROUP && sendFailures > 0) { sendFailures--; throw new Error('not connected'); } };
  const letters = {
    issued: [],
    issueLetter: async ref => {
      if (failLetter) throw new Error('browser not available');
      letters.issued.push(ref);
      return `/permits/${ref}.pdf`;
    },
  };
  const delivery = createDelivery({
    approvals, letters,
    sendText: async (to, text) => { maybeFail(to); out.push({ to, text }); return msg(); },
    sendFile: async (to, file, caption) => { maybeFail(to); out.push({ to, file, text: caption }); return msg(); },
    waitForAck: ack,
    getGroupId: () => groupId,
    log: { error: (...a) => errors.push(a.join(' ')) },
  });
  const toClient = () => out.filter(o => o.to === CLIENT);
  const toGroup = () => out.filter(o => o.to === GROUP);
  return { db, approvals, letters, delivery, out, errors, toClient, toGroup };
}

// ── outcomes ─────────────────────────────────────────────
test('approved: PDF sent with caption, notified, group told (no PII)', async () => {
  const h = harness();
  const ref = h.approvals.createRequest(sample(), 36);
  h.approvals.approve(ref, 'Siti', 'Bay B2');
  assert.equal(await h.delivery.deliver(ref), true);
  const [c] = h.toClient();
  assert.equal(c.file, '/permits/PP-0001.pdf');
  assert.match(c.text, /\*PP-0001\* has been approved/);
  assert.match(c.text, /Valid: 1 Nov 2026 – 30 Nov 2026/);
  assert.ok(h.approvals.getLog(ref).client_notified_at);
  assert.deepEqual(h.toGroup().map(g => g.text), ['📨 *PP-0001*: approval letter sent to the applicant.']);
});

test('rejected: reason sent to client, no letter generated', async () => {
  const h = harness();
  const ref = h.approvals.createRequest(sample(), 36);
  h.approvals.reject(ref, 'Siti', 'Car park full this month');
  assert.equal(await h.delivery.deliver(ref), true);
  assert.match(h.toClient()[0].text, /was not approved[\s\S]*Reason: Car park full this month[\s\S]*sending \*PERMIT\*/);
  assert.equal(h.toClient()[0].file, undefined);
  assert.deepEqual(h.letters.issued, []);
  assert.match(h.toGroup()[0].text, /applicant notified of the rejection/);
});

test('expired: client asked to resubmit, group told', async () => {
  const h = harness();
  const ref = h.approvals.createRequest(sample(), 36);
  h.db.prepare('UPDATE approval_log SET expires_at = ? WHERE ref_no = ?').run(new Date(Date.now() - 1000).toISOString(), ref);
  h.approvals.expireDue();
  assert.equal(await h.delivery.deliver(ref), true);
  assert.match(h.toClient()[0].text, /has expired[\s\S]*send \*PERMIT\*/);
  assert.match(h.toGroup()[0].text, /expired with no decision/);
});

test('pending, unknown, already-notified and purged requests are skipped', async () => {
  const h = harness();
  const pending = h.approvals.createRequest(sample(), 36);
  const done = h.approvals.createRequest(sample(), 36);
  h.approvals.approve(done, 'Siti');
  await h.delivery.deliver(done);
  const purged = h.approvals.createRequest(sample(), 36);
  h.approvals.reject(purged, 'Siti', 'full');
  h.approvals.markClientNotified(purged);
  h.approvals.purgeRow(purged);
  const before = h.out.length;
  for (const ref of [pending, done, purged, 'PP-9999']) assert.equal(await h.delivery.deliver(ref), false, ref);
  assert.equal(h.out.length, before);
});

test('single-day permit caption shows one date', async () => {
  const h = harness();
  const ref = h.approvals.createRequest(sample({ end: '2026-11-01' }), 36);
  h.approvals.approve(ref, 'Siti');
  await h.delivery.deliver(ref);
  assert.match(h.toClient()[0].text, /Valid: 1 Nov 2026\n/);
});

// ── failures and retries ─────────────────────────────────
test('send failure: not marked notified, retried by the sweep, succeeds later', async () => {
  const h = harness({ failSend: 1 });
  const ref = h.approvals.createRequest(sample(), 36);
  h.approvals.approve(ref, 'Siti');
  assert.equal(await h.delivery.deliver(ref), false);
  assert.equal(h.approvals.getLog(ref).client_notified_at, null);
  assert.match(h.errors[0], /delivering PP-0001 failed \(attempt 1\): not connected/);
  assert.equal(await h.delivery.deliverOutstanding(), 1);
  assert.ok(h.approvals.getLog(ref).client_notified_at);
  assert.equal(await h.delivery.deliverOutstanding(), 0, 'nothing left');
});

test('no ack (timeout or error) counts as failure and is retried', async () => {
  let fail = true;
  const h = harness({ ack: async () => { if (fail) throw new Error('no delivery confirmation within 60s'); } });
  const ref = h.approvals.createRequest(sample(), 36);
  h.approvals.reject(ref, 'Siti', 'full');
  assert.equal(await h.delivery.deliver(ref), false);
  assert.equal(h.approvals.getLog(ref).client_notified_at, null);
  fail = false;
  assert.equal(await h.delivery.deliverOutstanding(), 1);
});

test('letter render failure is retried; nothing sent to client meanwhile', async () => {
  const h = harness({ failLetter: true });
  const ref = h.approvals.createRequest(sample(), 36);
  h.approvals.approve(ref, 'Siti');
  assert.equal(await h.delivery.deliver(ref), false);
  assert.equal(h.toClient().length, 0);
  assert.match(h.errors[0], /browser not available/);
});

test('admins are warned once after 3 failed attempts; logs carry no PII', async () => {
  const h = harness({ failSend: 10 });
  const ref = h.approvals.createRequest(sample(), 36);
  h.approvals.approve(ref, 'Siti');
  for (let i = 0; i < 5; i++) await h.delivery.deliverOutstanding();
  const warns = h.toGroup().filter(g => g.text.startsWith('⚠️'));
  assert.deepEqual(warns.map(w => w.text), ['⚠️ *PP-0001*: couldn\'t reach the applicant after 3 attempts. The bot will keep retrying.']);
  assert.equal(h.errors.length, 5);
  for (const e of h.errors) for (const pii of ['Ahmad', 'WXY', '60111111111', 'Night']) assert.ok(!e.includes(pii), e);
});

test('group note failure or missing group does not undo the delivery', async () => {
  const h = harness({ groupId: '' });
  const ref = h.approvals.createRequest(sample(), 36);
  h.approvals.approve(ref, 'Siti');
  assert.equal(await h.delivery.deliver(ref), true);
  assert.equal(h.toGroup().length, 0);
  assert.ok(h.approvals.getLog(ref).client_notified_at);
});

test('hook and sweep at the same time deliver only once', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const h = harness({ ack: () => gate });
  const ref = h.approvals.createRequest(sample(), 36);
  h.approvals.approve(ref, 'Siti');
  const p1 = h.delivery.deliver(ref);
  const p2 = h.delivery.deliverOutstanding();
  release();
  assert.deepEqual(await Promise.all([p1, p2]), [true, 0]);
  assert.equal(h.toClient().length, 1);
});

test('delivered request becomes purgeable', async () => {
  const h = harness();
  const ref = h.approvals.createRequest(sample(), 36);
  h.approvals.approve(ref, 'Siti');
  await h.delivery.deliver(ref);
  assert.deepEqual(h.approvals.listPurgeable().map(p => p.ref_no), [ref]);
});

// ── ack waiter ───────────────────────────────────────────
const fakeClient = (extra = {}) => Object.assign(new EventEmitter(), extra);
const m = (id, ack = 0) => ({ id: { _serialized: id }, ack });

test('ack waiter: resolves immediately when already acked; rejects on error ack', async () => {
  const wait = createAckWaiter(fakeClient());
  await wait(m('a', 1));
  await wait(m('b', 3));
  await assert.rejects(wait(m('c', -1)), /send error/);
  await assert.rejects(wait(undefined), /no message/);
});

test('ack waiter: resolves on server ack event, ignores other messages', async () => {
  const c = fakeClient();
  const wait = createAckWaiter(c, { timeoutMs: 1000 });
  const p = wait(m('x'));
  c.emit('message_ack', m('other'), 1);
  c.emit('message_ack', m('x'), 0);
  c.emit('message_ack', m('x'), 1);
  await p;
});

test('ack waiter: rejects on error ack event', async () => {
  const c = fakeClient();
  const wait = createAckWaiter(c, { timeoutMs: 1000 });
  const p = wait(m('x'));
  c.emit('message_ack', m('x'), -1);
  await assert.rejects(p, /send error/);
});

test('ack waiter: on timeout, checks the message state before giving up', async () => {
  const acked = fakeClient({ getMessageById: async () => m('x', 2) });
  await createAckWaiter(acked, { timeoutMs: 10 })(m('x'));
  const never = fakeClient({ getMessageById: async () => m('y', 0) });
  await assert.rejects(createAckWaiter(never, { timeoutMs: 10 })(m('y')), /no delivery confirmation/);
});
