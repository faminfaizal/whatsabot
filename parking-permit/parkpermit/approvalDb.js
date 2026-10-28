// approvalDb.js — data layer for building parking permit approvals (whatsabot)
//
// Usage: const approvals = require('./approvalDb')(db);   // db = existing better-sqlite3 instance
//
// Two tables:
//   approval_requests — PII (deleted by purge)
//   approval_log      — no PII, kept permanently; single source of truth for status
'use strict';

const MAX_TIMEOUT_HOURS = 48;   // WhatsApp "delete for everyone" window is ~2 days
const FORCE_PURGE_DAYS = 7;     // purge even if client notification keeps failing

const SCHEMA = `
CREATE TABLE IF NOT EXISTS approval_log (
  id                 INTEGER PRIMARY KEY,
  ref_no             TEXT NOT NULL UNIQUE,
  request_type       TEXT NOT NULL DEFAULT 'PARKING_PERMIT',
  status             TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  permit_start       TEXT NOT NULL,             -- YYYY-MM-DD
  permit_end         TEXT NOT NULL,             -- YYYY-MM-DD
  approver_name      TEXT,                      -- from admin whitelist, not phone no.
  created_at         TEXT NOT NULL,             -- ISO UTC
  expires_at         TEXT NOT NULL,
  decided_at         TEXT,
  client_notified_at TEXT,
  purged_at          TEXT,
  CHECK (permit_end >= permit_start)
);
CREATE INDEX IF NOT EXISTS idx_approval_log_pending ON approval_log(status, expires_at);

CREATE TABLE IF NOT EXISTS approval_requests (
  ref_no         TEXT PRIMARY KEY REFERENCES approval_log(ref_no),
  client_jid     TEXT NOT NULL,
  applicant_name TEXT NOT NULL,
  car_reg        TEXT NOT NULL,
  justification  TEXT NOT NULL,
  remark         TEXT,
  reject_reason  TEXT,
  group_msg_id   TEXT,
  pdf_path       TEXT
);
CREATE INDEX IF NOT EXISTS idx_approval_requests_group_msg ON approval_requests(group_msg_id);
`;

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'];
const LOG_COLUMNS = `ref_no, request_type, status, permit_start, permit_end, approver_name,
                     created_at, expires_at, decided_at, client_notified_at, purged_at`;

// "42", "0042", "PP-0042", "pp42" -> "PP-0042"; null if not a ref
function normalizeRef(input) {
  const m = String(input || '').trim().match(/^(?:PP-?)?(\d{1,6})$/i);
  return m ? `PP-${String(Number(m[1])).padStart(4, '0')}` : null;
}

module.exports = function createApprovalDb(db) {
  db.exec(SCHEMA);
  const nowIso = () => new Date().toISOString();

  const s = {
    nextId:      db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM approval_log'),
    insertLog:   db.prepare(`INSERT INTO approval_log (id, ref_no, status, permit_start, permit_end, created_at, expires_at)
                             VALUES (?, ?, 'PENDING', ?, ?, ?, ?)`),
    insertReq:   db.prepare(`INSERT INTO approval_requests (ref_no, client_jid, applicant_name, car_reg, justification)
                             VALUES (?, ?, ?, ?, ?)`),
    getLog:      db.prepare('SELECT * FROM approval_log WHERE ref_no = ?'),
    getFull:     db.prepare(`SELECT l.*, r.client_jid, r.applicant_name, r.car_reg, r.justification,
                                    r.remark, r.reject_reason, r.group_msg_id, r.pdf_path
                             FROM approval_log l JOIN approval_requests r ON r.ref_no = l.ref_no
                             WHERE l.ref_no = ?`),
    decide:      db.prepare(`UPDATE approval_log SET status = ?, approver_name = ?, decided_at = ?
                             WHERE ref_no = ? AND status = 'PENDING' AND expires_at > ?`),
    setRemark:   db.prepare('UPDATE approval_requests SET remark = ? WHERE ref_no = ?'),
    setReason:   db.prepare('UPDATE approval_requests SET reject_reason = ? WHERE ref_no = ?'),
    setGroupMsg: db.prepare('UPDATE approval_requests SET group_msg_id = ? WHERE ref_no = ?'),
    byGroupMsg:  db.prepare('SELECT ref_no FROM approval_requests WHERE group_msg_id = ?'),
    byGroupKey:  db.prepare(`SELECT ref_no FROM approval_requests WHERE group_msg_id LIKE ? ESCAPE '\\'`),
    setPdf:      db.prepare('UPDATE approval_requests SET pdf_path = ? WHERE ref_no = ?'),
    notified:    db.prepare('UPDATE approval_log SET client_notified_at = ? WHERE ref_no = ? AND client_notified_at IS NULL'),
    due:         db.prepare(`SELECT l.ref_no, r.client_jid, r.group_msg_id
                             FROM approval_log l JOIN approval_requests r ON r.ref_no = l.ref_no
                             WHERE l.status = 'PENDING' AND l.expires_at <= ?`),
    expire:      db.prepare(`UPDATE approval_log SET status = 'EXPIRED', decided_at = ?
                             WHERE ref_no = ? AND status = 'PENDING'`),
    purgeable:   db.prepare(`SELECT l.ref_no, r.pdf_path, r.group_msg_id
                             FROM approval_log l JOIN approval_requests r ON r.ref_no = l.ref_no
                             WHERE l.purged_at IS NULL AND l.status != 'PENDING'
                               AND (l.client_notified_at IS NOT NULL OR l.decided_at <= ?)`),
    delReq:      db.prepare('DELETE FROM approval_requests WHERE ref_no = ?'),
    markPurged:  db.prepare('UPDATE approval_log SET purged_at = ? WHERE ref_no = ? AND purged_at IS NULL'),
    pendingFor:  db.prepare(`SELECT l.ref_no FROM approval_log l JOIN approval_requests r ON r.ref_no = l.ref_no
                             WHERE r.client_jid = ? AND r.car_reg = ? AND l.status = 'PENDING' AND l.expires_at > ?
                             ORDER BY l.id DESC LIMIT 1`),
    undelivered: db.prepare(`SELECT l.ref_no FROM approval_log l JOIN approval_requests r ON r.ref_no = l.ref_no
                             WHERE l.status != 'PENDING' AND l.client_notified_at IS NULL AND l.purged_at IS NULL
                             ORDER BY l.id`),
    unposted:    db.prepare(`SELECT l.ref_no FROM approval_log l JOIN approval_requests r ON r.ref_no = l.ref_no
                             WHERE l.status = 'PENDING' AND l.expires_at > ? AND r.group_msg_id IS NULL
                             ORDER BY l.id`),
    // Admin request log: approval_log only, never approval_requests (no PII)
    logPage:     db.prepare(`SELECT ${LOG_COLUMNS} FROM approval_log
                             WHERE (@status IS NULL OR status = @status)
                             ORDER BY id DESC LIMIT @limit OFFSET @offset`),
    logCount:    db.prepare(`SELECT COUNT(*) AS n FROM approval_log WHERE (@status IS NULL OR status = @status)`),
  };

  // Returns the new ref no. Caller has already validated/normalised the fields.
  const createRequest = db.transaction(({ clientJid, name, carReg, start, end, justification }, timeoutHours) => {
    const h = Number(timeoutHours);
    if (!(h >= 1 && h <= MAX_TIMEOUT_HOURS)) throw new RangeError(`timeoutHours must be 1–${MAX_TIMEOUT_HOURS}`);
    const now = new Date();
    const id = s.nextId.get().n;
    const ref = normalizeRef(id);
    s.insertLog.run(id, ref, start, end, now.toISOString(), new Date(now.getTime() + h * 3600e3).toISOString());
    s.insertReq.run(ref, clientJid, name, carReg, justification);
    return ref;
  });

  // First admin wins. Returns { ok: true } or { ok: false, current } (current = log row or null).
  const decide = db.transaction((status, ref, approverName, text) => {
    const r = s.decide.run(status, approverName, nowIso(), ref, nowIso());
    if (r.changes === 0) return { ok: false, current: s.getLog.get(ref) || null };
    (status === 'APPROVED' ? s.setRemark : s.setReason).run(text || null, ref);
    return { ok: true };
  });

  const approve = (ref, approverName, remark) => decide('APPROVED', ref, approverName, remark);
  const reject = (ref, approverName, reason) => {
    if (!reason || !String(reason).trim()) throw new Error('Reject reason is required');
    return decide('REJECTED', ref, approverName, reason.trim());
  };

  // Marks overdue PENDING requests EXPIRED; returns them so the caller can notify client + group.
  const expireDue = db.transaction(() => {
    const now = nowIso();
    return s.due.all(now).filter(row => s.expire.run(now, row.ref_no).changes === 1);
  });

  // Rows ready to purge. Caller deletes the PDF + group message, then calls purgeRow(ref).
  // Idempotent: if the process dies mid-purge, the row shows up again next sweep.
  const listPurgeable = () =>
    s.purgeable.all(new Date(Date.now() - FORCE_PURGE_DAYS * 864e5).toISOString());

  const purgeRow = db.transaction(ref => {
    s.delReq.run(ref);
    return s.markPurged.run(nowIso(), ref).changes === 1;
  });

  return {
    normalizeRef,
    createRequest,
    approve,
    reject,
    expireDue,
    listPurgeable,
    purgeRow,
    getRequest:         ref => s.getFull.get(ref) || null,   // for letter + notifications
    getLog:             ref => s.getLog.get(ref) || null,
    setGroupMsgId:      (ref, msgId) => s.setGroupMsg.run(msgId, ref),
    findRefByGroupMsg:  msgId => (s.byGroupMsg.get(msgId) || {}).ref_no || null,
    // Fallback match on the message's own key (id.id), since serialized IDs can differ in format
    findRefByGroupMsgKey: key => {
      if (!key || String(key).length < 8) return null;
      const esc = String(key).replace(/[\\%_]/g, c => `\\${c}`);
      return (s.byGroupKey.get(`%${esc}%`) || {}).ref_no || null;
    },
    setPdfPath:         (ref, p) => s.setPdf.run(p, ref),
    markClientNotified: ref => s.notified.run(nowIso(), ref).changes === 1,
    findPendingByClient: (clientJid, carReg) => (s.pendingFor.get(clientJid, carReg, nowIso()) || {}).ref_no || null,
    listUnposted:       () => s.unposted.all(nowIso()).map(r => r.ref_no),   // live PENDING not yet in admin group
    listUndelivered:    () => s.undelivered.all().map(r => r.ref_no),        // decided, client not yet notified
    // Newest first. status: one of STATUSES or empty for all. Returns { rows, total } with no PII.
    listLog: ({ status, limit = 50, offset = 0 } = {}) => {
      const st = status ? String(status).toUpperCase() : null;
      if (st && !STATUSES.includes(st)) throw new RangeError(`status must be one of ${STATUSES.join(', ')}`);
      const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
      const off = Math.max(parseInt(offset, 10) || 0, 0);
      return {
        rows: s.logPage.all({ status: st, limit: lim, offset: off }),
        total: s.logCount.get({ status: st }).n,
      };
    },
  };
};

module.exports.normalizeRef = normalizeRef;
module.exports.MAX_TIMEOUT_HOURS = MAX_TIMEOUT_HOURS;
