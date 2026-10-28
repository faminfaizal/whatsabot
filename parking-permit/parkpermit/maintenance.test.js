// Run: node --test maintenance.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const createApprovalDb = require('./approvalDb');
const { createMaintenance } = require('./maintenance');

const sample = (o = {}) => ({
  clientJid: '60111111111@c.us', name: 'Ahmad Faiz', carReg: 'WXY1234',
  start: '2026-11-01', end: '2026-11-30', justification: 'Night shift duty', ...o,
});
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'maint-'));
const past = (db, ref, col, ms = 1000) =>
  db.prepare(`UPDATE approval_log SET ${col} = ? WHERE ref_no = ?`).run(new Date(Date.now() - ms).toISOString(), ref);

function harness(opts = {}) {
  const db = new Database(':memory:');
  const approvals = createApprovalDb(db);
  const calls = [], deleted = [], warns = [], errors = [];
  const outDir = opts.outDir || tmpDir();
  const m = createMaintenance({
    approvals, outDir,
    adminGroup: { postUnposted: async () => { calls.push('post'); if (opts.failPost) throw new Error('group down'); return 0; } },
    delivery: { deliverOutstanding: async () => { calls.push('deliver'); return 0; } },
    deleteGroupMessage: async id => { if (opts.failDelete) throw new Error('not found'); deleted.push(id); },
    unlink: opts.unlink,
    intervalMs: opts.intervalMs,
    log: { warn: (...a) => warns.push(a.join(' ')), error: (...a) => errors.push(a.join(' ')) },
  });
  // A finished, notified request with a letter on disk and a group summary
  const finished = (status = 'APPROVED') => {
    const ref = approvals.createRequest(sample(), 36);
    approvals.setGroupMsgId(ref, `grp-${ref}`);
    if (status === 'APPROVED') {
      approvals.approve(ref, 'Siti');
      const p = path.join(outDir, `${ref}.pdf`);
      fs.writeFileSync(p, '%PDF');
      approvals.setPdfPath(ref, p);
    } else {
      approvals.reject(ref, 'Siti', 'full');
    }
    approvals.markClientNotified(ref);
    return ref;
  };
  return { db, approvals, m, calls, deleted, warns, errors, outDir, finished };
}

// ── expiry (task 7) ──────────────────────────────────────
test('runOnce expires overdue requests, then posts, delivers, purges, in that order', async () => {
  const h = harness();
  const overdue = h.approvals.createRequest(sample(), 36);
  const live = h.approvals.createRequest(sample(), 36);
  past(h.db, overdue, 'expires_at');
  const res = await h.m.runOnce();
  assert.equal(res.expired, 1);
  assert.equal(h.approvals.getLog(overdue).status, 'EXPIRED');
  assert.equal(h.approvals.getLog(live).status, 'PENDING');
  assert.deepEqual(h.calls, ['post', 'deliver']);
});

test('expired but not yet notified is NOT purged (client must hear first)', async () => {
  const h = harness();
  const ref = h.approvals.createRequest(sample(), 36);
  past(h.db, ref, 'expires_at');
  const res = await h.m.runOnce();
  assert.equal(res.purged, 0);
  assert.ok(h.approvals.getRequest(ref));
});

// ── purge (task 8) ───────────────────────────────────────
test('purge deletes group summary, letter file and PII row; log keeps no PII', async () => {
  const h = harness();
  const ref = h.finished('APPROVED');
  const pdf = h.approvals.getRequest(ref).pdf_path;
  const res = await h.m.runOnce();
  assert.equal(res.purged, 1);
  assert.deepEqual(h.deleted, [`grp-${ref}`]);
  assert.equal(fs.existsSync(pdf), false);
  assert.equal(h.approvals.getRequest(ref), null);
  const logRow = h.approvals.getLog(ref);
  assert.ok(logRow.purged_at);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM approval_requests').get().n, 0);
  const text = JSON.stringify(logRow);
  for (const pii of ['Ahmad', 'WXY', '60111111111', 'Night']) assert.ok(!text.includes(pii), pii);
});

test('rejected request (no letter) is purged too', async () => {
  const h = harness();
  const ref = h.finished('REJECTED');
  assert.equal((await h.m.runOnce()).purged, 1);
  assert.equal(h.approvals.getRequest(ref), null);
});

test('group summary delete failure is logged but does not block the purge', async () => {
  const h = harness({ failDelete: true });
  const ref = h.finished();
  assert.equal((await h.m.runOnce()).purged, 1);
  assert.match(h.warns[0], new RegExp(`group summary for ${ref}: not found`));
});

test('letter already gone (ENOENT) is fine', async () => {
  const h = harness();
  const ref = h.finished();
  fs.unlinkSync(h.approvals.getRequest(ref).pdf_path);
  assert.equal((await h.m.runOnce()).purged, 1);
});

test('letter that cannot be deleted blocks that purge until a later run succeeds', async () => {
  let locked = true;
  const h = harness({ unlink: async p => { if (locked) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } fs.unlinkSync(p); } });
  const ref = h.finished();
  assert.equal((await h.m.runOnce()).purged, 0);
  assert.ok(h.approvals.getRequest(ref), 'PII kept while the file still exists');
  assert.match(h.errors[0], /could not delete letter for PP-0001, will retry: EBUSY/);
  locked = false;
  assert.equal((await h.m.runOnce()).purged, 1);
});

test('force purge after 7 days even if the applicant was never reached', async () => {
  const h = harness();
  const ref = h.approvals.createRequest(sample(), 36);
  h.approvals.reject(ref, 'Siti', 'full');
  assert.equal((await h.m.runOnce()).purged, 0);
  past(h.db, ref, 'decided_at', 7 * 864e5 + 1000);
  assert.equal((await h.m.runOnce()).purged, 1);
});

// ── stray files ──────────────────────────────────────────
test('stray letter files for purged or unknown requests are removed; active ones and other files kept', async () => {
  const h = harness();
  const active = h.approvals.createRequest(sample(), 36);
  h.approvals.approve(active, 'Siti');
  const done = h.finished();
  await h.m.runOnce();   // purges `done`
  for (const f of [`${active}.pdf`, `${active}.pdf.tmp`, `${done}.pdf`, 'PP-0099.pdf', 'PP-0098.pdf.tmp', 'readme.txt', 'logo.png']) {
    fs.writeFileSync(path.join(h.outDir, f), 'x');
  }
  const res = await h.m.runOnce();
  assert.equal(res.strayFiles, 3);
  assert.deepEqual(fs.readdirSync(h.outDir).sort(), [`${active}.pdf`, `${active}.pdf.tmp`, 'logo.png', 'readme.txt'].sort());
});

test('missing letters folder is not an error', async () => {
  const h = harness({ outDir: path.join(tmpDir(), 'not-yet-created') });
  assert.equal((await h.m.runOnce()).strayFiles, 0);
  assert.deepEqual(h.errors, []);
});

// ── robustness ───────────────────────────────────────────
test('one failing step does not stop the others', async () => {
  const h = harness({ failPost: true });
  const ref = h.finished();
  const res = await h.m.runOnce();
  assert.deepEqual(h.calls, ['post', 'deliver']);
  assert.equal(res.purged, 1);
  assert.match(h.errors[0], /step "post" failed: group down/);
  assert.equal(h.approvals.getRequest(ref), null);
});

test('overlapping runs are skipped', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const db = new Database(':memory:');
  const m = createMaintenance({
    approvals: createApprovalDb(db), outDir: tmpDir(), deleteGroupMessage: async () => {},
    adminGroup: { postUnposted: () => gate }, delivery: { deliverOutstanding: async () => 0 },
    log: { warn() {}, error() {} },
  });
  const first = m.runOnce();
  assert.deepEqual(await m.runOnce(), { skipped: true });
  release();
  assert.equal((await first).skipped, undefined);
  assert.equal((await m.runOnce()).skipped, undefined, 'runs again once the first finished');
});

test('start runs immediately and on the interval; stop halts it; start is idempotent', async () => {
  const h = harness({ intervalMs: 30 });
  h.m.start(); h.m.start();
  await new Promise(r => setTimeout(r, 100));
  h.m.stop();
  const runs = h.calls.filter(c => c === 'post').length;
  assert.ok(runs >= 3 && runs <= 5, `ran ${runs} times`);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(h.calls.filter(c => c === 'post').length, runs, 'no runs after stop');
});
