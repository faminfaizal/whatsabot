// Run: node --test adminGroup.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const createApprovalDb = require('./approvalDb');
const { createIntake } = require('./intake');
const { createAdminGroup, logGroups, summaryText, formatDateTimeMYT } = require('./adminGroup');

const GROUP = '120363041234567890@g.us';
const sample = (o = {}) => ({
  clientJid: '60123456789@c.us', name: 'Ahmad Faiz', carReg: 'WXY1234',
  start: '2026-11-01', end: '2026-11-30', justification: 'Night shift duty', ...o,
});

function harness({ groupId = GROUP, send } = {}) {
  const db = new Database(':memory:');
  const approvals = createApprovalDb(db);
  const sent = [], warns = [], errors = [];
  let n = 0, gid = groupId;
  const adminGroup = createAdminGroup({
    approvals,
    send: send || (async (to, text) => { sent.push({ to, text }); return { id: { _serialized: `msg-${++n}` } }; }),
    getGroupId: () => gid,
    log: { warn: m => warns.push(m), error: (...a) => errors.push(a.join(' ')) },
  });
  return { db, approvals, adminGroup, sent, warns, errors, setGroup: g => { gid = g; } };
}

test('MYT time formatting', () => {
  assert.equal(formatDateTimeMYT('2026-10-27T03:13:00.000Z'), '27 Oct 2026, 11:13 AM');
  assert.equal(formatDateTimeMYT('2026-10-27T16:05:00.000Z'), '28 Oct 2026, 12:05 AM');
  assert.equal(formatDateTimeMYT('2026-10-27T04:00:00.000Z'), '27 Oct 2026, 12:00 PM');
});

test('summary shows details, day count, expiry and both ways to decide', () => {
  const text = summaryText({
    ref_no: 'PP-0042', applicant_name: 'Ahmad Faiz', car_reg: 'WXY1234',
    permit_start: '2026-11-01', permit_end: '2026-11-30', justification: 'Night shift duty',
    expires_at: '2026-10-27T03:13:00.000Z',
  });
  for (const s of ['*Parking permit request PP-0042*', 'Name: Ahmad Faiz', 'Car Reg: WXY 1234',
    'Period: 1 Nov 2026 – 30 Nov 2026 (30 days)', 'Justification: Night shift duty',
    'Expires 27 Oct 2026, 11:13 AM', '*APPROVE 0042*', '*REJECT 0042 reason*']) assert.ok(text.includes(s), s);
  assert.match(summaryText({ ref_no: 'PP-0001', applicant_name: 'A', car_reg: 'W1', permit_start: '2026-11-01',
    permit_end: '2026-11-01', justification: 'x', expires_at: '2026-10-27T03:13:00.000Z' }), /\(1 day\)/);
});

test('posts to the group and stores the message id; second call is a no-op', async () => {
  const h = harness();
  const ref = h.approvals.createRequest(sample(), 36);
  assert.equal(await h.adminGroup.postRequest(ref), true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].to, GROUP);
  assert.equal(h.approvals.getRequest(ref).group_msg_id, 'msg-1');
  assert.equal(h.approvals.findRefByGroupMsg('msg-1'), ref);
  assert.equal(await h.adminGroup.postRequest(ref), false);
  assert.equal(h.sent.length, 1);
});

test('no group id: queues, warns once, then posts the backlog in order once set', async () => {
  const h = harness({ groupId: '' });
  const r1 = h.approvals.createRequest(sample(), 36);
  const r2 = h.approvals.createRequest(sample({ carReg: 'ABC1' }), 36);
  assert.equal(await h.adminGroup.postRequest(r1), false);
  assert.equal(await h.adminGroup.postRequest(r2), false);
  assert.equal(await h.adminGroup.postUnposted(), 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.warns.length, 1);
  assert.match(h.warns[0], /not set/);

  h.setGroup(GROUP);
  assert.equal(await h.adminGroup.postUnposted(), 2);
  assert.deepEqual(h.sent.map(s => s.text.match(/PP-\d+/)[0]), [r1, r2]);
  assert.equal(await h.adminGroup.postUnposted(), 0, 'nothing left');
});

test('a value that is not a group id is rejected with a clear warning', async () => {
  const h = harness({ groupId: '60123456789@c.us' });
  const ref = h.approvals.createRequest(sample(), 36);
  assert.equal(await h.adminGroup.postRequest(ref), false);
  assert.match(h.warns[0], /should end in @g\.us/);
});

test('send failure leaves it unposted; next sweep retries', async () => {
  let fail = true, n = 0;
  const h = harness({ send: async () => { if (fail) throw new Error('not connected'); return { id: { _serialized: `m${++n}` } }; } });
  const ref = h.approvals.createRequest(sample(), 36);
  await assert.rejects(h.adminGroup.postRequest(ref), /not connected/);
  assert.equal(h.approvals.getRequest(ref).group_msg_id, null);
  assert.equal(await h.adminGroup.postUnposted(), 0);
  assert.match(h.errors[0], new RegExp(`${ref}.*not connected`));
  fail = false;
  assert.equal(await h.adminGroup.postUnposted(), 1);
  assert.equal(h.approvals.getRequest(ref).group_msg_id, 'm1');
});

test('send that returns no message id is treated as a failure', async () => {
  const h = harness({ send: async () => undefined });
  const ref = h.approvals.createRequest(sample(), 36);
  await assert.rejects(h.adminGroup.postRequest(ref), /no message id/);
  assert.equal(h.approvals.getRequest(ref).group_msg_id, null);
});

test('decided or expired requests are not posted', async () => {
  const h = harness();
  const decided = h.approvals.createRequest(sample(), 36);
  h.approvals.approve(decided, 'Siti');
  const expired = h.approvals.createRequest(sample({ carReg: 'ABC1' }), 36);
  h.db.prepare('UPDATE approval_log SET expires_at = ? WHERE ref_no = ?').run(new Date(Date.now() - 1000).toISOString(), expired);
  assert.equal(await h.adminGroup.postRequest(decided), false);
  assert.equal(await h.adminGroup.postRequest(expired), false);
  assert.equal(await h.adminGroup.postRequest('PP-9999'), false);
  assert.equal(h.sent.length, 0);
});

test('onCreated and the sweep running at the same time post only once', async () => {
  let release, n = 0;
  const gate = new Promise(r => { release = r; });
  const sent = [];
  const h = harness({ send: async (to, text) => { sent.push(text); await gate; return { id: { _serialized: `m${++n}` } }; } });
  const ref = h.approvals.createRequest(sample(), 36);
  const p1 = h.adminGroup.postRequest(ref);
  const p2 = h.adminGroup.postUnposted();
  release();
  assert.deepEqual(await Promise.all([p1, p2]), [true, 0]);
  assert.equal(sent.length, 1);
});

test('end to end: client DM → intake → admin group post', async () => {
  const h = harness();
  const clientMsgs = [];
  const intake = createIntake({
    approvals: h.approvals,
    send: async (to, text) => { clientMsgs.push(text); },
    getTimeoutHours: () => 36,
    onCreated: ref => h.adminGroup.postRequest(ref),
    today: () => '2026-10-25',
    log: { error: () => {} },
  });
  await intake.handle({ from: '60123456789@c.us', fromMe: false,
    body: 'PERMIT\nName: Ahmad Faiz\nCar Reg: WXY 1234\nStart: 01/11/2026\nEnd: 30/11/2026\nJustification: Night shift duty' });
  assert.match(clientMsgs[0], /PP-0001/);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /Parking permit request PP-0001/);
  assert.equal(h.approvals.findRefByGroupMsg('msg-1'), 'PP-0001');
});

test('logGroups lists only groups with their ids', async () => {
  const logged = [];
  const fakeClient = { getChats: async () => [
    { isGroup: true, name: 'Parking Admins', id: { _serialized: GROUP } },
    { isGroup: false, name: 'Ali', id: { _serialized: '601111@c.us' } },
  ] };
  const groups = await logGroups(fakeClient, { log: m => logged.push(m) });
  assert.deepEqual(groups, [{ name: 'Parking Admins', id: GROUP }]);
  assert.ok(logged.some(l => l.includes(`Parking Admins → ${GROUP}`)));
  assert.ok(!logged.some(l => l.includes('Ali')));
});
