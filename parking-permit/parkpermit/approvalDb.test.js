// Run: node --test approvalDb.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const createApprovalDb = require('./approvalDb');

const sample = (o = {}) => ({
  clientJid: '60123456789@c.us', name: 'Ahmad Faiz', carReg: 'WXY1234',
  start: '2026-11-01', end: '2026-11-30', justification: 'Night shift', ...o,
});
const fresh = () => { const db = new Database(':memory:'); return { db, a: createApprovalDb(db) }; };
const backdate = (db, ref, col, ms) =>
  db.prepare(`UPDATE approval_log SET ${col} = ? WHERE ref_no = ?`).run(new Date(Date.now() - ms).toISOString(), ref);

test('ref numbers are sequential and normalise', () => {
  const { a } = fresh();
  assert.equal(a.createRequest(sample(), 36), 'PP-0001');
  assert.equal(a.createRequest(sample(), 36), 'PP-0002');
  for (const x of ['2', '0002', 'PP-0002', 'pp2', ' PP0002 ']) assert.equal(a.normalizeRef(x), 'PP-0002');
  for (const x of ['', 'abc', 'PP-', '12a']) assert.equal(a.normalizeRef(x), null);
});

test('timeout must be 1–48h', () => {
  const { a } = fresh();
  for (const h of [0, 49, 'x', undefined]) assert.throws(() => a.createRequest(sample(), h), RangeError);
  assert.doesNotThrow(() => a.createRequest(sample(), 48));
});

test('end date before start is rejected by the db', () => {
  const { a } = fresh();
  assert.throws(() => a.createRequest(sample({ start: '2026-11-30', end: '2026-11-01' }), 36));
  assert.equal(a.getLog('PP-0001'), null, 'transaction rolled back');
});

test('first admin wins; second sees who decided', () => {
  const { a } = fresh();
  const ref = a.createRequest(sample(), 36);
  assert.deepEqual(a.approve(ref, 'Siti', 'Bay B2 only'), { ok: true });
  const second = a.approve(ref, 'Raj', 'ok');
  assert.equal(second.ok, false);
  assert.equal(second.current.approver_name, 'Siti');
  assert.equal(a.reject(ref, 'Raj', 'no').ok, false);
  const r = a.getRequest(ref);
  assert.equal(r.status, 'APPROVED');
  assert.equal(r.remark, 'Bay B2 only');
});

test('approve without remark stores null; unknown ref fails cleanly', () => {
  const { a } = fresh();
  const ref = a.createRequest(sample(), 36);
  assert.equal(a.approve(ref, 'Siti').ok, true);
  assert.equal(a.getRequest(ref).remark, null);
  assert.deepEqual(a.approve('PP-9999', 'Siti'), { ok: false, current: null });
});

test('reject requires a reason', () => {
  const { a } = fresh();
  const ref = a.createRequest(sample(), 36);
  assert.throws(() => a.reject(ref, 'Siti', '  '));
  assert.equal(a.reject(ref, 'Siti', 'Car park full').ok, true);
  assert.equal(a.getRequest(ref).reject_reason, 'Car park full');
});

test('expired requests cannot be approved and are returned once by expireDue', () => {
  const { db, a } = fresh();
  const ref = a.createRequest(sample(), 36);
  const other = a.createRequest(sample(), 36);
  a.setGroupMsgId(ref, 'grp-msg-1');
  backdate(db, ref, 'expires_at', 1000);
  assert.equal(a.approve(ref, 'Siti').ok, false);
  const expired = a.expireDue();
  assert.deepEqual(expired, [{ ref_no: ref, client_jid: '60123456789@c.us', group_msg_id: 'grp-msg-1' }]);
  assert.deepEqual(a.expireDue(), [], 'not returned twice');
  assert.equal(a.getLog(ref).status, 'EXPIRED');
  assert.equal(a.getLog(other).status, 'PENDING');
});

test('quote-reply lookup by group message id', () => {
  const { a } = fresh();
  const ref = a.createRequest(sample(), 36);
  a.setGroupMsgId(ref, 'true_1203@g.us_ABC');
  assert.equal(a.findRefByGroupMsg('true_1203@g.us_ABC'), ref);
  assert.equal(a.findRefByGroupMsg('nope'), null);
});

test('findPendingByClient only matches live pending requests for same client + car', () => {
  const { db, a } = fresh();
  const ref = a.createRequest(sample(), 36);
  assert.equal(a.findPendingByClient('60123456789@c.us', 'WXY1234'), ref);
  assert.equal(a.findPendingByClient('60123456789@c.us', 'ABC1'), null, 'other car');
  assert.equal(a.findPendingByClient('60199999999@c.us', 'WXY1234'), null, 'other client');
  backdate(db, ref, 'expires_at', 1000);
  assert.equal(a.findPendingByClient('60123456789@c.us', 'WXY1234'), null, 'expired');
  const ref2 = a.createRequest(sample(), 36);
  a.approve(ref2, 'Siti');
  assert.equal(a.findPendingByClient('60123456789@c.us', 'WXY1234'), null, 'decided');
});

test('listUnposted returns live pending requests without a group message, oldest first', () => {
  const { db, a } = fresh();
  const r1 = a.createRequest(sample(), 36);
  const r2 = a.createRequest(sample(), 36);
  const r3 = a.createRequest(sample(), 36);
  const r4 = a.createRequest(sample(), 36);
  a.setGroupMsgId(r2, 'posted');
  a.approve(r3, 'Siti');
  backdate(db, r4, 'expires_at', 1000);
  assert.deepEqual(a.listUnposted(), [r1]);
});

test('listUndelivered returns decided requests whose client is not yet notified', () => {
  const { db, a } = fresh();
  const approved = a.createRequest(sample(), 36);
  const rejected = a.createRequest(sample(), 36);
  const expired = a.createRequest(sample(), 36);
  const pending = a.createRequest(sample(), 36);
  const notified = a.createRequest(sample(), 36);
  a.approve(approved, 'Siti');
  a.reject(rejected, 'Siti', 'full');
  backdate(db, expired, 'expires_at', 1000); a.expireDue();
  a.approve(notified, 'Siti'); a.markClientNotified(notified);
  assert.deepEqual(a.listUndelivered(), [approved, rejected, expired]);
  assert.ok(pending);
});

test('purge waits for client notification, then removes all PII', () => {
  const { db, a } = fresh();
  const ref = a.createRequest(sample(), 36);
  const pending = a.createRequest(sample(), 36);
  a.approve(ref, 'Siti', 'ok');
  a.setPdfPath(ref, 'D:/whatsabot/permits/PP-0001.pdf');
  assert.deepEqual(a.listPurgeable(), [], 'not before client is notified');
  assert.equal(a.markClientNotified(ref), true);
  assert.equal(a.markClientNotified(ref), false, 'first notification time kept');
  const [row] = a.listPurgeable();
  assert.equal(row.ref_no, ref);
  assert.equal(row.pdf_path, 'D:/whatsabot/permits/PP-0001.pdf');
  assert.equal(a.purgeRow(ref), true);
  assert.equal(a.purgeRow(ref), false, 'idempotent');
  assert.equal(a.getRequest(ref), null);
  const log = a.getLog(ref);
  assert.ok(log.purged_at);
  const logText = JSON.stringify(log);
  for (const pii of ['Ahmad', 'WXY1234', '60123456789', 'Night shift']) assert.ok(!logText.includes(pii), pii);
  assert.deepEqual(a.listPurgeable(), []);
  assert.ok(a.getRequest(pending), 'pending request untouched');
});

test('force purge after 7 days if client was never notified', () => {
  const { db, a } = fresh();
  const ref = a.createRequest(sample(), 36);
  a.reject(ref, 'Siti', 'no');
  backdate(db, ref, 'decided_at', 6 * 864e5);
  assert.deepEqual(a.listPurgeable(), []);
  backdate(db, ref, 'decided_at', 7 * 864e5 + 1000);
  assert.equal(a.listPurgeable()[0].ref_no, ref);
});

test('survives restart: schema is idempotent and data persists', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'appr-')), 'test.db');
  let db = new Database(file);
  const ref = createApprovalDb(db).createRequest(sample(), 36);
  db.close();
  db = new Database(file);
  const a = createApprovalDb(db);
  assert.equal(a.getLog(ref).status, 'PENDING');
  assert.equal(a.createRequest(sample(), 36), 'PP-0002');
  db.close();
});

test('listLog: newest first, status filter, paging, total, and no PII columns', () => {
  const { a } = fresh();
  const refs = [1, 2, 3, 4].map(() => a.createRequest(sample(), 36));
  a.approve(refs[0], 'Siti', 'Bay B2');
  a.reject(refs[1], 'Siti', 'Car park full');

  const all = a.listLog();
  assert.equal(all.total, 4);
  assert.deepEqual(all.rows.map(r => r.ref_no), ['PP-0004', 'PP-0003', 'PP-0002', 'PP-0001']);
  assert.deepEqual(Object.keys(all.rows[0]).sort(), ['approver_name', 'client_notified_at', 'created_at', 'decided_at',
    'expires_at', 'permit_end', 'permit_start', 'purged_at', 'ref_no', 'request_type', 'status']);
  const text = JSON.stringify(all);
  for (const pii of ['Ahmad', 'WXY1234', '60123456789', 'Night shift', 'Bay B2', 'Car park full']) assert.ok(!text.includes(pii), pii);

  assert.deepEqual(a.listLog({ status: 'approved' }).rows.map(r => r.ref_no), ['PP-0001']);
  assert.equal(a.listLog({ status: 'PENDING' }).total, 2);
  const page2 = a.listLog({ limit: 2, offset: 2 });
  assert.deepEqual(page2.rows.map(r => r.ref_no), ['PP-0002', 'PP-0001']);
  assert.equal(page2.total, 4);
  assert.equal(a.listLog({ limit: 9999 }).rows.length, 4, 'limit is capped, not rejected');
  assert.throws(() => a.listLog({ status: 'DROP TABLE' }), /status must be one of/);
});
