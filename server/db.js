const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const DB_PATH = path.join(DATA_DIR, 'whatsabot.db');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDir(DATA_DIR);
ensureDir(SESSIONS_DIR);

// ─── SQLite Setup ─────────────────────────────────────────────────

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    sessionId             TEXT PRIMARY KEY,
    phone                 TEXT,
    name                  TEXT,
    credits               INTEGER DEFAULT 0,
    status                TEXT DEFAULT 'active',
    banned                INTEGER DEFAULT 0,
    createdAt             TEXT,
    lastSeen              TEXT,
    totalSent             INTEGER DEFAULT 0,
    dailyLimit            INTEGER DEFAULT 200,
    hourlyLimit           INTEGER DEFAULT 30,
    safeHoursStart        INTEGER DEFAULT 8,
    safeHoursEnd          INTEGER DEFAULT 21,
    consecutiveFailures   INTEGER DEFAULT 0,
    cooldownUntil         TEXT,
    qrAttempts            INTEGER DEFAULT 0,
    notes                 TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id          TEXT PRIMARY KEY,
    sessionId   TEXT NOT NULL,
    to_number   TEXT NOT NULL,
    message     TEXT NOT NULL,
    scheduledAt TEXT NOT NULL,
    repeat      TEXT DEFAULT 'once',
    status      TEXT DEFAULT 'pending',
    createdAt   TEXT, 
    external_id TEXT,
    FOREIGN KEY (sessionId) REFERENCES users(sessionId)
  );

  -- Browser access tokens. Only the SHA-256 is stored; a sessionId alone grants nothing.
  -- No FK: the token is issued before WhatsApp links and the users row exists.
  CREATE TABLE IF NOT EXISTS session_tokens (
    tokenHash   TEXT PRIMARY KEY,
    sessionId   TEXT NOT NULL,
    createdAt   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_session_tokens_sid ON session_tokens(sessionId);

  -- Outbox. Mirrors the in-memory queue so a restart doesn't lose unsent messages.
  CREATE TABLE IF NOT EXISTS queue_jobs (
    id          TEXT PRIMARY KEY,
    sessionId   TEXT NOT NULL,
    to_number   TEXT NOT NULL,
    message     TEXT NOT NULL,
    priority    INTEGER NOT NULL,
    scheduledAt TEXT,
    campaignId  TEXT,
    scheduleId  TEXT,
    createdAt   TEXT NOT NULL
  );

  -- Every feed msg_id ever imported by the scraper. Kept separately from schedules so that
  -- clearing finished schedules can never make an old feed row look new (and be sent twice).
  CREATE TABLE IF NOT EXISTS scraper_imports (
    external_id TEXT PRIMARY KEY,
    importedAt  TEXT NOT NULL
  );
`);

// Backfill: msg_ids imported before scraper_imports existed
db.prepare(`INSERT OR IGNORE INTO scraper_imports (external_id, importedAt)
            SELECT external_id, COALESCE(createdAt, datetime('now')) FROM schedules WHERE external_id IS NOT NULL`).run();

// Owner row for scraper-imported schedules (schedules.sessionId has an FK to users).
// It has no phone, so it never appears in session lists and is never restored as a client.
const SYSTEM_SESSION_ID = 'system';
db.prepare(`INSERT OR IGNORE INTO users (sessionId, name, credits, status, createdAt)
            VALUES (?, 'System (scraper)', 0, 'system', ?)`)
  .run(SYSTEM_SESSION_ID, new Date().toISOString());

// ─── Migration from JSON ──────────────────────────────────────────

function migrateFromJSON() {
  const usersFile = path.join(DATA_DIR, 'users.json');
  if (fs.existsSync(usersFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
      const insert = db.prepare(`
        INSERT OR IGNORE INTO users
          (sessionId, phone, name, credits, status, banned, createdAt, lastSeen,
           totalSent, dailyLimit, hourlyLimit, safeHoursStart, safeHoursEnd,
           consecutiveFailures, cooldownUntil, notes)
        VALUES
          (@sessionId, @phone, @name, @credits, @status, @banned, @createdAt, @lastSeen,
           @totalSent, @dailyLimit, @hourlyLimit, @safeHoursStart, @safeHoursEnd,
           @consecutiveFailures, @cooldownUntil, @notes)
      `);
      const migrate = db.transaction(() => {
        for (const [sid, u] of Object.entries(existing)) {
          insert.run({
            sessionId: sid,
            phone: u.phone || null,
            name: u.name || null,
            credits: u.credits || 0,
            status: u.status || 'active',
            banned: u.banned ? 1 : 0,
            createdAt: u.createdAt || new Date().toISOString(),
            lastSeen: u.lastSeen || new Date().toISOString(),
            totalSent: u.totalSent || 0,
            dailyLimit: u.dailyLimit || 200,
            hourlyLimit: u.hourlyLimit || 30,
            safeHoursStart: u.safeHoursStart || 8,
            safeHoursEnd: u.safeHoursEnd || 21,
            consecutiveFailures: u.consecutiveFailures || 0,
            cooldownUntil: u.cooldownUntil || null,
            notes: u.notes || '',
          });
        }
      });
      migrate();
      fs.renameSync(usersFile, usersFile + '.migrated');
      console.log('✅ Migrated users.json → SQLite');
    } catch (e) {
      console.error('⚠️ users.json migration failed:', e.message);
    }
  }

  // Migrate schedules from each session folder
  if (fs.existsSync(SESSIONS_DIR)) {
    const insertSched = db.prepare(`
      INSERT OR IGNORE INTO schedules
        (id, sessionId, to_number, message, scheduledAt, repeat, status, createdAt)
      VALUES
        (@id, @sessionId, @to_number, @message, @scheduledAt, @repeat, @status, @createdAt)
    `);
    const migrateSched = db.transaction((sessionId, schedules) => {
      for (const s of schedules) {
        insertSched.run({
          id: s.id,
          sessionId,
          to_number: s.to,
          message: s.message,
          scheduledAt: s.scheduledAt,
          repeat: s.repeat || 'once',
          status: s.status || 'pending',
          createdAt: s.createdAt || new Date().toISOString(),
        });
      }
    });

    for (const sid of fs.readdirSync(SESSIONS_DIR)) {
      const schedFile = path.join(SESSIONS_DIR, sid, 'schedules.json');
      if (fs.existsSync(schedFile)) {
        try {
          const schedules = JSON.parse(fs.readFileSync(schedFile, 'utf8'));
          // Check if user exists in DB — skip orphaned sessions
          const userExists = db.prepare('SELECT 1 FROM users WHERE sessionId = ?').get(sid);
          if (!userExists) {
            fs.renameSync(schedFile, schedFile + '.migrated');
            console.log(`🧹 Dropped orphaned schedules for ${sid} (no user found)`);
            continue;
          }
          if (schedules.length > 0) {
            migrateSched(sid, schedules);
            console.log(`✅ Migrated schedules for ${sid}`);
          }
          fs.renameSync(schedFile, schedFile + '.migrated');
        } catch (e) {
          console.error(`⚠️ Schedule migration failed for ${sid}:`, e.message);
        }
      }
    }
  }
}

migrateFromJSON();

// ─── JSON Helpers (for settings, logs, queue, admin_logs) ─────────

function readJSON(filePath, defaultVal = {}) {
  try {
    if (!fs.existsSync(filePath)) return defaultVal;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return defaultVal; }
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─── Settings (JSON) ──────────────────────────────────────────────

function getSettings() {
  return readJSON(path.join(DATA_DIR, 'settings.json'), {
    defaultCredits: parseInt(process.env.DEFAULT_CREDITS) || 100,
    minDelayMs: parseInt(process.env.MIN_DELAY_MS) || 3000,
    maxDelayMs: parseInt(process.env.MAX_DELAY_MS) || 8000,
    maxPerRun: parseInt(process.env.MAX_PER_RUN) || 50,
    maxPerHour: parseInt(process.env.MAX_PER_HOUR) || 30,
    maxPerDay: parseInt(process.env.MAX_PER_DAY) || 200,
    safeHoursStart: parseInt(process.env.SAFE_HOURS_START) || 8,
    safeHoursEnd: parseInt(process.env.SAFE_HOURS_END) || 21,
    autoPauseFailures: parseInt(process.env.AUTO_PAUSE_FAILURES) || 3,
    cooldownMinutes: parseInt(process.env.COOLDOWN_MINUTES) || 5,
  });
}

function saveSettings(settings) {
  writeJSON(path.join(DATA_DIR, 'settings.json'), settings);
}

// ─── Users (SQLite) ───────────────────────────────────────────────

function rowToUser(row) {
  if (!row) return null;
  return {
    ...row,
    banned: row.banned === 1,
    cooldownUntil: row.cooldownUntil || null,
  };
}

function getUsers() {
  const rows = db.prepare('SELECT * FROM users').all();
  const result = {};
  for (const row of rows) result[row.sessionId] = rowToUser(row);
  return result;
}

function getUserByPhone(phone) {
  const row = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  return rowToUser(row);
}

// saveUsers is called from whatsapp.js for ghost session cleanup
// saveUsers is called from whatsapp.js for ghost session cleanup
function saveUsers(users) {
  const existing = db.prepare('SELECT sessionId FROM users').all().map(r => r.sessionId);
  const incoming = Object.keys(users);
  const toDelete = existing.filter(sid => !incoming.includes(sid));
  const delSchedules = db.prepare('DELETE FROM schedules WHERE sessionId = ?');
  const delUser = db.prepare('DELETE FROM users WHERE sessionId = ?');
  const delTokens = db.prepare('DELETE FROM session_tokens WHERE sessionId = ?');
  const deleteAll = db.transaction(() => {
    for (const sid of toDelete) {
      delSchedules.run(sid); // remove child rows first
      delTokens.run(sid);
      delUser.run(sid);
    }
  });
  deleteAll();
}

function getUser(sessionId) {
  const row = db.prepare('SELECT * FROM users WHERE sessionId = ?').get(sessionId);
  return rowToUser(row);
}

function saveUser(sessionId, data) {
  const existing = getUser(sessionId);
  if (!existing) {
    // INSERT
    const fields = Object.keys(data);
    const cols = ['sessionId', ...fields].join(', ');
    const placeholders = ['@sessionId', ...fields.map(f => `@${f}`)].join(', ');
    db.prepare(`INSERT OR IGNORE INTO users (${cols}) VALUES (${placeholders})`)
      .run({ sessionId, ...data, banned: data.banned ? 1 : 0 });
  } else {
    // UPDATE only provided fields
    const fields = Object.keys(data);
    if (fields.length === 0) return existing;
    const sets = fields.map(f => `${f} = @${f}`).join(', ');
    const params = { sessionId, ...data };
    if ('banned' in params) params.banned = params.banned ? 1 : 0;
    db.prepare(`UPDATE users SET ${sets} WHERE sessionId = @sessionId`).run(params);
  }
  return getUser(sessionId);
}

function createUser(sessionId, phone, name) {
  const settings = getSettings();
  const user = {
    sessionId,
    phone,
    name: name || phone,
    credits: settings.defaultCredits,
    status: 'active',
    banned: false,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    totalSent: 0,
    dailyLimit: settings.maxPerDay,
    hourlyLimit: settings.maxPerHour,
    safeHoursStart: settings.safeHoursStart,
    safeHoursEnd: settings.safeHoursEnd,
    consecutiveFailures: 0,
    cooldownUntil: null,
    notes: '',
  };
  db.prepare(`
    INSERT OR REPLACE INTO users
      (sessionId, phone, name, credits, status, banned, createdAt, lastSeen,
       totalSent, dailyLimit, hourlyLimit, safeHoursStart, safeHoursEnd,
       consecutiveFailures, cooldownUntil, notes)
    VALUES
      (@sessionId, @phone, @name, @credits, @status, @banned, @createdAt, @lastSeen,
       @totalSent, @dailyLimit, @hourlyLimit, @safeHoursStart, @safeHoursEnd,
       @consecutiveFailures, @cooldownUntil, @notes)
  `).run({ ...user, banned: 0 });
  return user;
}

function deleteUser(sessionId) {
  db.prepare('DELETE FROM schedules WHERE sessionId = ?').run(sessionId);
  db.prepare('DELETE FROM session_tokens WHERE sessionId = ?').run(sessionId);
  db.prepare('DELETE FROM users WHERE sessionId = ?').run(sessionId);
}

// ─── Session tokens (SQLite) ──────────────────────────────────────

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

// Issues a new random token for a session. Returns the raw token (only the browser keeps it).
function createSessionToken(sessionId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO session_tokens (tokenHash, sessionId, createdAt) VALUES (?, ?, ?)')
    .run(hashToken(token), sessionId, new Date().toISOString());
  return token;
}

function getSessionIdByToken(token) {
  if (!token || typeof token !== 'string') return null;
  const row = db.prepare('SELECT sessionId FROM session_tokens WHERE tokenHash = ?').get(hashToken(token));
  return row ? row.sessionId : null;
}

function deleteSessionToken(token) {
  if (!token || typeof token !== 'string') return;
  db.prepare('DELETE FROM session_tokens WHERE tokenHash = ?').run(hashToken(token));
}

// ─── Contacts (JSON, per session) ────────────────────────────────

function getUserContacts(sessionId) {
  return readJSON(path.join(SESSIONS_DIR, sessionId, 'contacts.json'), []);
}

function saveUserContacts(sessionId, contacts) {
  writeJSON(path.join(SESSIONS_DIR, sessionId, 'contacts.json'), contacts);
}

// ─── Schedules (SQLite) ───────────────────────────────────────────

function rowToSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    to: row.to_number,
    message: row.message,
    scheduledAt: row.scheduledAt,
    repeat: row.repeat,
    status: row.status,
    createdAt: row.createdAt,
    sessionId: row.sessionId,
    external_id: row.external_id || null,
  };
}

function getUserSchedules(sessionId) {
  return db.prepare('SELECT * FROM schedules WHERE sessionId = ?')
    .all(sessionId)
    .map(rowToSchedule);
}

function saveUserSchedules(sessionId, schedules) {
  const del = db.prepare('DELETE FROM schedules WHERE sessionId = ?');
  // external_id must survive the rewrite: the scraper's duplicate check depends on it
  const ins = db.prepare(`
    INSERT OR REPLACE INTO schedules
      (id, sessionId, to_number, message, scheduledAt, repeat, status, createdAt, external_id)
    VALUES
      (@id, @sessionId, @to_number, @message, @scheduledAt, @repeat, @status, @createdAt, @external_id)
  `);
  const sync = db.transaction(() => {
    del.run(sessionId);
    for (const s of schedules) {
      ins.run({
        id: s.id,
        sessionId,
        to_number: s.to,
        message: s.message,
        scheduledAt: s.scheduledAt,
        repeat: s.repeat || 'once',
        status: s.status || 'pending',
        createdAt: s.createdAt || new Date().toISOString(),
        external_id: s.external_id || null,
      });
    }
  });
  sync();
}

function setScheduleStatus(id, status) {
  db.prepare('UPDATE schedules SET status = ? WHERE id = ?').run(status, id);
}

function getAllSchedules() {
  return db.prepare(`
    SELECT s.*, u.name as userName, u.phone as userPhone
    FROM schedules s
    LEFT JOIN users u ON s.sessionId = u.sessionId
  `).all().map(row => ({
    ...rowToSchedule(row),
    userName: row.userName,
    userPhone: row.userPhone,
  }));
}

// Duplicate check for the scraper: has this feed msg_id ever been imported?
function getScheduleByExternalId(externalId) {
  if (!externalId) return null;
  return db.prepare('SELECT external_id FROM scraper_imports WHERE external_id = ?').get(externalId) || null;
}

// Direct single schedule insert (used by scraper); records the msg_id in the same transaction
const insertScheduleTx = db.transaction(s => {
  db.prepare(`
    INSERT INTO schedules
      (id, sessionId, to_number, message, scheduledAt, repeat, status, createdAt, external_id)
    VALUES
      (@id, @sessionId, @to_number, @message, @scheduledAt, @repeat, @status, @createdAt, @external_id)
  `).run({
    id: s.id,
    sessionId: s.sessionId,
    to_number: s.to,
    message: s.message,
    scheduledAt: s.scheduledAt,
    repeat: s.repeat || 'once',
    status: s.status || 'pending',
    createdAt: s.createdAt || new Date().toISOString(),
    external_id: s.external_id || null,
  });
  if (s.external_id) {
    db.prepare('INSERT OR IGNORE INTO scraper_imports (external_id, importedAt) VALUES (?, ?)')
      .run(s.external_id, new Date().toISOString());
  }
});
function insertSchedule(s) { insertScheduleTx(s); }

// ─── Logs (JSON, per session) ─────────────────────────────────────

function getUserLogs(sessionId) {
  return readJSON(path.join(SESSIONS_DIR, sessionId, 'logs.json'), []);
}

function addUserLog(sessionId, logEntry) {
  const logs = getUserLogs(sessionId);
  logs.unshift({ ...logEntry, id: require('uuid').v4(), createdAt: new Date().toISOString() });
  writeJSON(path.join(SESSIONS_DIR, sessionId, 'logs.json'), logs.slice(0, 1000));
}

function getAllLogs() {
  const users = getUsers();
  let all = [];
  for (const sid of Object.keys(users)) {
    const logs = getUserLogs(sid);
    logs.forEach(l => all.push({ ...l, sessionId: sid, userName: users[sid]?.name }));
  }
  return all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ─── Queue (SQLite) ───────────────────────────────────────────────

function getQueue() {
  return db.prepare('SELECT * FROM queue_jobs ORDER BY priority, createdAt').all().map(r => ({
    id: r.id,
    sessionId: r.sessionId,
    to: r.to_number,
    message: r.message,
    priority: r.priority,
    scheduledAt: r.scheduledAt,
    campaignId: r.campaignId,
    scheduleId: r.scheduleId,
    createdAt: r.createdAt,
  }));
}

function insertQueueJob(j) {
  db.prepare(`
    INSERT OR REPLACE INTO queue_jobs
      (id, sessionId, to_number, message, priority, scheduledAt, campaignId, scheduleId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(j.id, j.sessionId, j.to, j.message, j.priority, j.scheduledAt || null,
         j.campaignId || null, j.scheduleId || null, j.createdAt);
}

function deleteQueueJob(id) {
  db.prepare('DELETE FROM queue_jobs WHERE id = ?').run(id);
}

function clearQueueJobs() {
  db.prepare('DELETE FROM queue_jobs').run();
}

// ─── Admin Logs (JSON) ────────────────────────────────────────────

function addAdminLog(entry) {
  const logs = readJSON(path.join(DATA_DIR, 'admin_logs.json'), []);
  logs.unshift({ ...entry, id: require('uuid').v4(), createdAt: new Date().toISOString() });
  writeJSON(path.join(DATA_DIR, 'admin_logs.json'), logs.slice(0, 500));
}

function getAdminLogs() {
  return readJSON(path.join(DATA_DIR, 'admin_logs.json'), []);
}

module.exports = {
  getSettings, saveSettings,
  getUsers, getUserByPhone, saveUsers, getUser, saveUser, createUser, deleteUser,
  createSessionToken, getSessionIdByToken, deleteSessionToken,
  getUserContacts, saveUserContacts,
  getUserSchedules, saveUserSchedules, setScheduleStatus, getAllSchedules, getScheduleByExternalId, insertSchedule,
  getUserLogs, addUserLog, getAllLogs,
  getQueue, insertQueueJob, deleteQueueJob, clearQueueJobs,
  SYSTEM_SESSION_ID,
  addAdminLog, getAdminLogs,
};