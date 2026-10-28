// Run: node --test approvalListener.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const createApprovalDb = require('./approvalDb');
const { createApprovalListener, parseWid, normalizeNumber } = require('./approvalListener');

const GROUP = '120363041234567890@g.us';
const SITI = '60123456789@c.us';
const RAJ = '60198765432@c.us';
const sample = (o = {}) => ({
  clientJid: '60111111111@c.us', name: 'Ahmad Faiz', carReg: 'WXY1234',
  start: '2026-11-01', end: '2026-11-30', justification: 'Night shift duty', ...o,
});

function harness({ approvers, failHook } = {}) {
  const db = new Database(':memory:');
  const approvals = createApprovalDb(db);
  const approved = [], rejected = [], warns = [], errors = [];
  const listener = createApprovalListener({
    approvals,
    getGroupId: () => GROUP,
    getApprovers: () => approvers || [
      { number: '012-345 6789', name: 'Siti Aminah' },
      { number: '60198765432', name: 'Raj Kumar' },
      { lid: '987654321012345@lid', name: 'Lee Wei' },
    ],
    onApproved: async ref => { approved.push(ref); if (failHook) throw new Error('pdf failed'); },
    onRejected: async ref => { rejected.push(ref); },
    log: { warn: m => warns.push(m), error: (...a) => errors.push(a.join(' ')) },
  });
  let n = 0;
  // Creates a request and records its (pretend) admin-group summary message id
  const newRequest = (o = {}) => {
    const ref = approvals.createRequest(sample(o), 36);
    const key = `3EB0${String(++n).padStart(12, '0')}`;
    const msgId = `true_${GROUP}_${key}`;
    approvals.setGroupMsgId(ref, msgId);
    return { ref, msgId, key };
  };
  return { db, approvals, listener, approved, rejected, warns, errors, newRequest };
}

// Fake whatsapp-web.js Message
function gmsg(body, { author = SITI, quoted, from = GROUP, fromMe = false, contactNumber } = {}) {
  const replies = [];
  return {
    from, author, body, fromMe, replies,
    hasQuotedMsg: !!quoted,
    getQuotedMessage: async () => quoted,
    getContact: async () => ({ number: contactNumber }),
    reply: async t => { replies.push(t); },
  };
}
const quoteOf = ({ msgId, key }, serialized = msgId) => ({ id: { _serialized: serialized, id: key } });

// ── helpers ──────────────────────────────────────────────
test('parseWid and normalizeNumber', () => {
  assert.deepEqual(parseWid('60123456789@c.us'), { digits: '60123456789', kind: 'phone' });
  assert.deepEqual(parseWid('60123456789:12@c.us'), { digits: '60123456789', kind: 'phone' });
  assert.deepEqual(parseWid('987654321012345@lid'), { digits: '987654321012345', kind: 'lid' });
  assert.equal(parseWid('nonsense'), null);
  assert.equal(normalizeNumber('012-345 6789'), '60123456789');
  assert.equal(normalizeNumber('+60 12-345 6789'), '60123456789');
});

// ── typed commands ───────────────────────────────────────
test('APPROVE 0001 remark: decided, remark stored, group told, hook fired', async () => {
  const h = harness();
  const { ref } = h.newRequest();
  const m = gmsg('APPROVE 0001 Bay B2 only');
  assert.equal(await h.listener.handle(m), true);
  const r = h.approvals.getRequest(ref);
  assert.equal(r.status, 'APPROVED');
  assert.equal(r.approver_name, 'Siti Aminah');
  assert.equal(r.remark, 'Bay B2 only');
  assert.deepEqual(m.replies, [`✅ *${ref}* approved by Siti Aminah.`]);
  assert.deepEqual(h.approved, [ref]);
});

test('accepts lowercase, bold, PP- prefix, short number and separators', async () => {
  const h = harness();
  const bodies = ['approve 1', '*APPROVE* PP-0002 - ok', 'Approve pp3: fine', 'APPROVE 0004, noted'];
  for (const b of bodies) { h.newRequest(); await h.listener.handle(gmsg(b)); }
  assert.deepEqual(h.approved, ['PP-0001', 'PP-0002', 'PP-0003', 'PP-0004']);
  assert.deepEqual(['PP-0001', 'PP-0002', 'PP-0003', 'PP-0004'].map(r => h.approvals.getRequest(r).remark),
    [null, 'ok', 'fine', 'noted']);
});

test('REJECT needs a reason', async () => {
  const h = harness();
  const { ref } = h.newRequest();
  const m1 = gmsg('REJECT 1');
  await h.listener.handle(m1);
  assert.match(m1.replies[0], /include a reason: \*REJECT 0001 reason\*/);
  assert.equal(h.approvals.getLog(ref).status, 'PENDING');
  const m2 = gmsg('REJECT 1 Car park full this month');
  await h.listener.handle(m2);
  assert.equal(h.approvals.getRequest(ref).reject_reason, 'Car park full this month');
  assert.deepEqual(m2.replies, [`❌ *${ref}* rejected by Siti Aminah.`]);
  assert.deepEqual(h.rejected, [ref]);
});

test('command with no request number and no quote → usage help', async () => {
  const h = harness();
  h.newRequest();
  const m = gmsg('APPROVE looks fine');
  await h.listener.handle(m);
  assert.match(m.replies[0], /Which request\?/);
  assert.deepEqual(h.approved, []);
});

test('remark and reason length limits', async () => {
  const h = harness();
  h.newRequest();
  const m = gmsg(`APPROVE 1 ${'x'.repeat(301)}`);
  await h.listener.handle(m);
  assert.match(m.replies[0], /remark is too long \(max 300/);
  const m2 = gmsg(`REJECT 1 ${'x'.repeat(501)}`);
  await h.listener.handle(m2);
  assert.match(m2.replies[0], /reason is too long \(max 500/);
  assert.equal(h.approvals.getLog('PP-0001').status, 'PENDING');
});

// ── quote-replies ────────────────────────────────────────
test('quote-reply APPROVE uses the quoted request; the whole text is the remark', async () => {
  const h = harness();
  const req = h.newRequest();
  await h.listener.handle(gmsg('APPROVE Bay B2 only', { quoted: quoteOf(req) }));
  assert.equal(h.approvals.getRequest(req.ref).remark, 'Bay B2 only');
  assert.deepEqual(h.approved, [req.ref]);
});

test('quote-reply with a remark starting with a number that is not a request', async () => {
  const h = harness();
  const req = h.newRequest();
  await h.listener.handle(gmsg('APPROVE 2 cars max', { quoted: quoteOf(req) }));
  assert.equal(h.approvals.getRequest(req.ref).remark, '2 cars max');
});

test('quote-reply that also types the same number strips it', async () => {
  const h = harness();
  const req = h.newRequest();
  await h.listener.handle(gmsg('REJECT 0001 Full', { quoted: quoteOf(req) }));
  assert.equal(h.approvals.getRequest(req.ref).reject_reason, 'Full');
});

test('quote-reply to one request while typing another real request → conflict, nothing decided', async () => {
  const h = harness();
  const r1 = h.newRequest();
  const r2 = h.newRequest();
  const m = gmsg('APPROVE 2', { quoted: quoteOf(r1) });
  await h.listener.handle(m);
  assert.match(m.replies[0], /replied to \*PP-0001\* but typed \*PP-0002\*/);
  assert.equal(h.approvals.getLog(r1.ref).status, 'PENDING');
  assert.equal(h.approvals.getLog(r2.ref).status, 'PENDING');
});

test('quoted message matched by its key when the serialized id format differs', async () => {
  const h = harness();
  const req = h.newRequest();
  const q = quoteOf(req, `true_${GROUP}_${req.key}_60100000000@c.us`);
  await h.listener.handle(gmsg('APPROVE', { quoted: q }));
  assert.deepEqual(h.approved, [req.ref]);
});

test('quoting an unrelated message falls back to the typed number', async () => {
  const h = harness();
  const req = h.newRequest();
  const q = { id: { _serialized: 'false_x@g.us_ZZZZZZZZZZZZ', id: 'ZZZZZZZZZZZZ' } };
  const m1 = gmsg('APPROVE ok', { quoted: q });
  await h.listener.handle(m1);
  assert.match(m1.replies[0], /Which request\?/);
  await h.listener.handle(gmsg('APPROVE 1', { quoted: q }));
  assert.deepEqual(h.approved, [req.ref]);
});

// ── who may approve ──────────────────────────────────────
test('non-approver is refused and their ID is logged for the admin', async () => {
  const h = harness();
  const { ref } = h.newRequest();
  const m = gmsg('APPROVE 1', { author: '60177777777@c.us' });
  await h.listener.handle(m);
  assert.match(m.replies[0], /Only registered approvers/);
  assert.match(h.warns[0], /60177777777@c\.us/);
  assert.equal(h.approvals.getLog(ref).status, 'PENDING');
});

test('approver matched by local-format number, device suffix, LID, or contact number', async () => {
  const h = harness();
  h.newRequest(); h.newRequest(); h.newRequest();
  await h.listener.handle(gmsg('APPROVE 1', { author: '60123456789:7@c.us' }));
  await h.listener.handle(gmsg('APPROVE 2', { author: '987654321012345@lid' }));
  await h.listener.handle(gmsg('APPROVE 3', { author: '111222333444555@lid', contactNumber: '60198765432' }));
  assert.deepEqual(['PP-0001', 'PP-0002', 'PP-0003'].map(r => h.approvals.getLog(r).approver_name),
    ['Siti Aminah', 'Lee Wei', 'Raj Kumar']);
});

test('approvers list entries without a name or id are ignored', async () => {
  const h = harness({ approvers: [{ number: '60123456789' }, { name: 'Ghost' }] });
  h.newRequest();
  const m = gmsg('APPROVE 1');
  await h.listener.handle(m);
  assert.match(m.replies[0], /Only registered approvers/);
});

// ── outcomes ─────────────────────────────────────────────
test('second admin is told who already decided', async () => {
  const h = harness();
  h.newRequest();
  await h.listener.handle(gmsg('APPROVE 1'));
  const m = gmsg('REJECT 1 too late', { author: RAJ });
  await h.listener.handle(m);
  assert.deepEqual(m.replies, ['*PP-0001* was already approved by Siti Aminah.']);
  assert.deepEqual(h.rejected, []);
});

test('expired (even before the expiry sweep) and unknown requests', async () => {
  const h = harness();
  const { ref } = h.newRequest();
  h.db.prepare('UPDATE approval_log SET expires_at = ? WHERE ref_no = ?').run(new Date(Date.now() - 1000).toISOString(), ref);
  const m1 = gmsg('APPROVE 1');
  await h.listener.handle(m1);
  assert.match(m1.replies[0], /\*PP-0001\* has expired/);
  h.approvals.expireDue();
  const m2 = gmsg('APPROVE 1');
  await h.listener.handle(m2);
  assert.match(m2.replies[0], /has expired/);
  const m3 = gmsg('APPROVE 99');
  await h.listener.handle(m3);
  assert.equal(m3.replies[0], '*PP-0099* was not found.');
});

test('hook failure is logged without PII; the decision stands', async () => {
  const h = harness({ failHook: true });
  const { ref } = h.newRequest();
  const m = gmsg('APPROVE 1');
  await h.listener.handle(m);
  assert.equal(h.approvals.getLog(ref).status, 'APPROVED');
  assert.match(h.errors[0], /APPROVE of PP-0001: pdf failed/);
  for (const pii of ['Ahmad', 'WXY', '60111111111']) assert.ok(!h.errors[0].includes(pii));
});

test('group confirmation messages contain no applicant details', async () => {
  const h = harness();
  h.newRequest(); h.newRequest();
  const a = gmsg('APPROVE 1 Bay B2'); const r = gmsg('REJECT 2 Car park full');
  await h.listener.handle(a); await h.listener.handle(r);
  for (const t of [...a.replies, ...r.replies]) {
    for (const pii of ['Ahmad', 'WXY', 'Night shift', 'Bay B2', 'Car park full']) assert.ok(!t.includes(pii), `${pii} in "${t}"`);
  }
});

// ── ignored messages ─────────────────────────────────────
test('ignores other groups, DMs, own messages, and normal chat', async () => {
  const h = harness();
  h.newRequest();
  const cases = [
    gmsg('APPROVE 1', { from: '999@g.us' }),
    gmsg('APPROVE 1', { from: SITI }),
    gmsg('APPROVE 1', { fromMe: true }),
    gmsg('Approved, thanks all'),
    gmsg('I approve of this plan'),
    gmsg('approves 1'),
  ];
  for (const m of cases) {
    assert.equal(await h.listener.handle(m), false, m.body);
    assert.equal(m.replies.length, 0);
  }
  assert.equal(h.approvals.getLog('PP-0001').status, 'PENDING');
});

test('no group configured → listener does nothing', async () => {
  const db = new Database(':memory:');
  const approvals = createApprovalDb(db);
  const listener = createApprovalListener({ approvals, getGroupId: () => '', getApprovers: () => [] });
  assert.equal(await listener.handle(gmsg('APPROVE 1')), false);
});
