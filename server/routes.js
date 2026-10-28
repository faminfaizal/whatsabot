const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const wa = require('./whatsapp');
const queue = require('./queue');
const {
  adminAuth, userAuth, bearer,
  adminConfigError, checkAdminCredentials, signAdminToken,
  loginLockedFor, recordLoginFailure, clearLoginFailures,
} = require('./middleware');

// ─── SESSION / AUTH ───────────────────────────────────────────────

// Start a WhatsApp session (generates QR). With a valid session token this resumes that
// session; otherwise a brand-new session and token are issued. A client-supplied sessionId
// is never trusted.
router.post('/session/start', async (req, res) => {
  try {
    let sessionId = db.getSessionIdByToken(bearer(req));
    let token = null;
    if (!sessionId) {
      sessionId = uuidv4();
      token = db.createSessionToken(sessionId);
    }
    if (wa.isConnected(sessionId)) {
      // Already connected — just return user info, frontend will load it
      console.log(`♻️ Resuming existing session: ${sessionId}`);
      res.json({ sessionId, alreadyConnected: true, ...(token && { token }) });
    } else {
      // Starts a socket, or no-ops if one is already connecting (its QR / ready events will follow)
      await wa.createClient(sessionId);
      res.json({ sessionId, alreadyConnected: false, ...(token && { token }) });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Forget this browser's token (the WhatsApp link itself stays up for scheduled sends)
router.post('/session/logout', (req, res) => {
  db.deleteSessionToken(bearer(req));
  res.json({ success: true });
});

// All sessions (admin only — lists phone numbers)
router.get('/sessions', adminAuth, (req, res) => {
    const users = db.getUsers();
    const list = Object.entries(users)
    .filter(([sid, u]) => u.phone)
    .map(([sid, u]) => ({
      sessionId: sid,
      phone: u.phone,
      name: u.name,
      credits: u.credits,
      status: wa.isConnected(sid) ? 'connected' : 'disconnected',
      banned: u.banned,
  }));
  res.json(list);
});

// Get current user info
router.get('/me/:sessionId?', userAuth, (req, res) => {
  const user = db.getUser(req.sessionId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ ...user, connected: wa.isConnected(user.sessionId) });
});

// ─── CONTACTS ────────────────────────────────────────────────────

router.get('/contacts/:sessionId', userAuth, async (req, res) => {
  try {
    let contacts = db.getUserContacts(req.sessionId);
    // Contacts arrive via WhatsApp events; a refresh re-reads the groups from the live socket
    if (contacts.length === 0 || req.query.refresh === 'true') {
      contacts = await wa.refreshContacts(req.sessionId);
    }
    res.json(contacts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── LOCAL CONTACTS (shared CSV) ─────────────────────────────────

router.get('/local-contacts', userAuth, (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const filePath = path.join(__dirname, 'data', 'local_contacts.csv');
  if (!fs.existsSync(filePath)) return res.json([]);
  const csv = fs.readFileSync(filePath, 'utf8');
  const lines = csv.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim().replace(/^\uFEFF/, ''));
  const contacts = lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim());
    const obj = {};
    headers.forEach((h, i) => obj[h] = vals[i] || '');
    return {
      id: `local_${obj.number}`,
      number: obj.number,
      name: obj.name,
      isGroup: false,
      isLocal: true,
      meta: obj, // all columns available as {{placeholders}}
    };
  }).filter(c => c.number);
  res.json(contacts);
});

router.post('/local-contacts', adminAuth, (req, res) => {
  // Save updated CSV (for future edit feature) — shared list, admin only
  const fs = require('fs');
  const path = require('path');
  const { contacts } = req.body;
  if (!contacts?.length) return res.status(400).json({ error: 'No contacts' });
  const headers = Object.keys(contacts[0].meta || { number: '', name: '' });
  const lines = [headers.join(',')];
  contacts.forEach(c => lines.push(headers.map(h => c.meta?.[h] || '').join(',')));
  fs.writeFileSync(path.join(__dirname, 'data', 'local_contacts.csv'), lines.join('\n'));
  res.json({ saved: contacts.length });
});

// ─── MESSAGING ───────────────────────────────────────────────────

// Send instant message
router.post('/send', userAuth, async (req, res) => {
  const { to, message } = req.body;
  const sessionId = req.sessionId;
  if (!to || !message) return res.status(400).json({ error: 'Missing fields' });
  
  try {
    const job = queue.addToQueue({ sessionId, to, message, priority: 0 });
    res.json({ queued: true, jobId: job.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bulk send to multiple recipients
router.post('/bulk', userAuth, async (req, res) => {
  const { recipients, message } = req.body;
  const sessionId = req.sessionId;
  if (!recipients?.length || !message) return res.status(400).json({ error: 'Missing fields' });

  const user = db.getUser(sessionId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.credits < recipients.length) {
    return res.status(400).json({ error: `Insufficient credits. You have ${user.credits}, need ${recipients.length}` });
  }

  const settings = db.getSettings();
  const maxRun = Math.min(recipients.length, settings.maxPerRun);
  const jobs = [];

  for (let i = 0; i < maxRun; i++) {
    const r = recipients[i];
    // Use pre-personalized message if provided (from CSV upload), else personalize here
    const personalizedMsg = r.message || Object.entries(r).reduce(
      (msg, [key, val]) => msg.replace(new RegExp(`{{${key}}}`, 'g'), val),
      message
    );
    
    const job = queue.addToQueue({
      sessionId,
      to: r.number || r.id || r,
      message: personalizedMsg,
      priority: 2,
    });
    jobs.push(job.id);
  }

  res.json({ queued: jobs.length, jobIds: jobs });
});

// ─── SCHEDULES ───────────────────────────────────────────────────

router.get('/schedules/:sessionId', userAuth, (req, res) => {
  res.json(db.getUserSchedules(req.sessionId));
});

const REPEATS = ['once', 'hourly', 'daily', 'daily-weekday', 'weekly', 'monthly'];

// One recipient ({ to, message }) or many ({ recipients: [{ to, message }] }, already personalised).
// Same limits as /bulk: at most maxPerRun recipients, and enough credits for one run.
router.post('/schedules', userAuth, (req, res) => {
  const { to, message, scheduledAt, repeat = 'once', recipients } = req.body;
  const sessionId = req.sessionId;
  const list = Array.isArray(recipients) ? recipients : (to && message ? [{ to, message }] : []);
  if (!list.length || !scheduledAt) return res.status(400).json({ error: 'Missing fields' });
  if (list.some(r => !r || typeof r.to !== 'string' || !r.to.trim() || typeof r.message !== 'string' || !r.message.trim())) {
    return res.status(400).json({ error: 'Each recipient needs a number and a message' });
  }
  const when = new Date(scheduledAt);
  if (isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid date' });
  if (!REPEATS.includes(repeat)) return res.status(400).json({ error: 'Invalid repeat' });

  const settings = db.getSettings();
  if (list.length > settings.maxPerRun) {
    return res.status(400).json({ error: `At most ${settings.maxPerRun} recipients per schedule` });
  }
  const user = db.getUser(sessionId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.credits < list.length) {
    return res.status(400).json({ error: `Insufficient credits. You have ${user.credits}, need ${list.length}` });
  }

  const createdAt = new Date().toISOString();
  const created = list.map(r => ({
    id: uuidv4(),
    to: r.to.trim(),
    message: r.message,
    scheduledAt: when.toISOString(),
    repeat,
    status: 'pending',
    createdAt,
  }));
  db.saveUserSchedules(sessionId, [...db.getUserSchedules(sessionId), ...created]);
  res.json({ scheduled: created.length, schedules: created });
});

router.delete('/schedules/:sessionId/:id', userAuth, (req, res) => {
  let schedules = db.getUserSchedules(req.sessionId);
  schedules = schedules.filter(s => s.id !== req.params.id);
  db.saveUserSchedules(req.sessionId, schedules);
  res.json({ success: true });
});

// ─── LOGS ────────────────────────────────────────────────────────

router.get('/logs/:sessionId', userAuth, (req, res) => {
  const logs = db.getUserLogs(req.sessionId);
  res.json(logs);
});

router.delete('/logs/:sessionId', userAuth, (req, res) => {
  const path = require('path');
  const fs = require('fs');
  const logPath = path.join(__dirname, 'sessions', req.sessionId, 'logs.json');
  if (fs.existsSync(logPath)) fs.writeFileSync(logPath, '[]');
  res.json({ success: true });
});

// ─── QUEUE ───────────────────────────────────────────────────────

// Own jobs only
router.get('/queue', userAuth, (req, res) => {
  res.json(queue.getQueueStats(req.sessionId));
});

router.delete('/queue/:jobId', userAuth, (req, res) => {
  const removed = queue.removeFromQueue(req.params.jobId, req.sessionId);
  if (!removed) return res.status(404).json({ error: 'Job not found' });
  res.json({ success: true });
});

// ─── ADMIN AUTH ───────────────────────────────────────────────────

router.post('/admin/login', (req, res) => {
  const configError = adminConfigError();
  if (configError) {
    console.error(`⛔ Admin login refused: ${configError}`);
    return res.status(503).json({ error: 'Admin login is disabled until the server is configured' });
  }

  const ip = req.ip;
  const lockedMs = loginLockedFor(ip);
  if (lockedMs > 0) {
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(lockedMs / 60000)} min.` });
  }

  const { username, password } = req.body;
  if (checkAdminCredentials(username, password)) {
    clearLoginFailures(ip);
    res.json({ token: signAdminToken() });
  } else {
    recordLoginFailure(ip);
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// ─── ADMIN ROUTES (protected) ────────────────────────────────────

router.get('/admin/users', adminAuth, (req, res) => {
  const users = db.getUsers();
  const list = Object.entries(users)
    .filter(([sid]) => sid !== db.SYSTEM_SESSION_ID)
    .map(([sid, u]) => ({
      ...u,
      sessionId: sid,
      connected: wa.isConnected(sid),
    }));
  res.json(list);
});

router.put('/admin/users/:sessionId', adminAuth, (req, res) => {
  const { credits, status, banned, dailyLimit, hourlyLimit, notes } = req.body;
  const update = {};
  if (credits !== undefined) update.credits = parseInt(credits);
  if (status !== undefined) update.status = status;
  if (banned !== undefined) update.banned = banned;
  if (dailyLimit !== undefined) update.dailyLimit = parseInt(dailyLimit);
  if (hourlyLimit !== undefined) update.hourlyLimit = parseInt(hourlyLimit);
  if (notes !== undefined) update.notes = notes;
  
  const user = db.saveUser(req.params.sessionId, update);
  db.addAdminLog({ type: 'user_edit', message: `Edited user ${user?.name}`, sessionId: req.params.sessionId });
  res.json(user);
});

router.post('/admin/users/:sessionId/add-credits', adminAuth, (req, res) => {
  const { amount } = req.body;
  const user = db.getUser(req.params.sessionId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const newCredits = (user.credits || 0) + parseInt(amount);
  db.saveUser(req.params.sessionId, { credits: newCredits });
  db.addAdminLog({ type: 'credits', message: `Added ${amount} credits to ${user.name}`, sessionId: req.params.sessionId });
  res.json({ credits: newCredits });
});

// Scrape external feed
router.post('/admin/scrape-feed', adminAuth, async (req, res) => {
  try {
    const feedUrl = req.body.feedUrl;
    if (feedUrl) {
      if (!/^https?:\/\//i.test(feedUrl)) return res.status(400).json({ error: 'Feed URL must start with http:// or https://' });
      process.env.SCRAPER_FEED_URL = feedUrl;   // remembered for later runs (until restart)
    }
    const scraper = require('./scraper');
    const result = await scraper.runScraper();
    db.addAdminLog({
      type: 'scraper',
      message: `Scrape: ${result.imported} imported, ${result.skipped_duplicate} dup, ${result.skipped_no_contact} no-contact`
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get scraper config
router.get('/admin/scraper-config', adminAuth, (req, res) => {
  res.json({ feedUrl: process.env.SCRAPER_FEED_URL || '' });
});

// Test feed connectivity + preview rows (no insert)
router.post('/admin/test-feed', adminAuth, async (req, res) => {
  const axios = require('axios');
  const cheerio = require('cheerio');
  const { feedUrl } = req.body;
  if (!feedUrl) return res.status(400).json({ error: 'No URL provided' });
  try {
    const response = await axios.get(feedUrl, { timeout: 15000 });
    const $ = cheerio.load(response.data);
    const rows = [];
    $('#wssched-feed tbody tr').each((_, row) => {
      const $r = $(row);
      rows.push({
        msg_id: $r.attr('data-msgid'),
        to_username: $r.find('.to_username').text().trim(),
        message: $r.find('.message').text().trim(),
        scheduledAt: $r.find('.scheduledAt').text().trim(),
        msg_status: $r.find('.msg_status').text().trim(),
      });
    });
    res.json({ ok: true, rowCount: rows.length, rows });
  } catch (e) {
    res.status(200).json({
      ok: false,
      error: e.message,
      code: e.code || null,
      status: e.response?.status || null,
    });
  }
});

router.get('/admin/schedules', adminAuth, (req, res) => {
  res.json(db.getAllSchedules());
});

router.get('/admin/logs', adminAuth, (req, res) => {
  res.json(db.getAllLogs().slice(0, 500));
});

router.get('/admin/activity', adminAuth, (req, res) => {
  res.json(db.getAdminLogs());
});

router.get('/admin/queue', adminAuth, (req, res) => {
  res.json(queue.getQueueStats());
});

router.post('/admin/queue/pause', adminAuth, (req, res) => {
  queue.pauseQueue();
  db.addAdminLog({ type: 'queue', message: 'Queue paused by admin' });
  res.json({ paused: true });
});

router.post('/admin/queue/resume', adminAuth, (req, res) => {
  queue.resumeQueue();
  db.addAdminLog({ type: 'queue', message: 'Queue resumed by admin' });
  res.json({ paused: false });
});

router.delete('/admin/queue', adminAuth, (req, res) => {
  queue.clearQueue();
  db.addAdminLog({ type: 'queue', message: 'Queue flushed by admin' });
  res.json({ success: true });
});
// Clear completed/queued schedules
router.delete('/admin/schedules', adminAuth, (req, res) => {
  const db = require('./db');
  const Database = require('better-sqlite3');
  const path = require('path');
  const result = Database(path.join(__dirname, 'data', 'whatsabot.db'))
    .prepare("DELETE FROM schedules WHERE status IN ('queued', 'sent', 'failed')")
    .run();
  db.addAdminLog({ type: 'schedules', message: `Cleared ${result.changes} completed schedules` });
  res.json({ cleared: result.changes });
});

// Clear all logs across all sessions
router.delete('/admin/logs', adminAuth, (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const sessionsDir = path.join(__dirname, 'sessions');
  let cleared = 0;
  if (fs.existsSync(sessionsDir)) {
    for (const sid of fs.readdirSync(sessionsDir)) {
      const logPath = path.join(sessionsDir, sid, 'logs.json');
      if (fs.existsSync(logPath)) {
        fs.writeFileSync(logPath, '[]');
        cleared++;
      }
    }
  }
  const db = require('./db');
  db.addAdminLog({ type: 'logs', message: `Cleared logs for ${cleared} sessions` });
  res.json({ cleared });
});

router.get('/admin/settings', adminAuth, (req, res) => {
  res.json(db.getSettings());
});

// Known settings and their allowed integer ranges; anything else in the body is ignored
const SETTING_RANGES = {
  defaultCredits:    [0, 100000],
  minDelayMs:        [500, 600000],
  maxDelayMs:        [500, 600000],
  maxPerRun:         [1, 1000],
  maxPerHour:        [1, 10000],
  maxPerDay:         [1, 100000],
  safeHoursStart:    [0, 23],
  safeHoursEnd:      [0, 23],
  autoPauseFailures: [1, 100],
  cooldownMinutes:   [0, 1440],
};

router.put('/admin/settings', adminAuth, (req, res) => {
  const settings = db.getSettings();
  const updated = {};
  const errors = [];
  for (const [key, [min, max]] of Object.entries(SETTING_RANGES)) {
    const raw = req.body?.[key];
    if (raw === undefined) { updated[key] = settings[key]; continue; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) errors.push(`${key} must be a whole number from ${min} to ${max}`);
    else updated[key] = n;
  }
  if (!errors.length && updated.minDelayMs > updated.maxDelayMs) errors.push('minDelayMs must not exceed maxDelayMs');
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  db.saveSettings(updated);
  db.addAdminLog({ type: 'settings', message: 'Settings updated by admin' });
  res.json(updated);
});

// Stats for admin overview
router.get('/admin/stats', adminAuth, (req, res) => {
  const users = db.getUsers();
  const clients = wa.getAllClients();
  const allLogs = db.getAllLogs();
  const today = new Date().toDateString();
  const timeframe = req.query.timeframe || '1W';
  const now = new Date();

  const sentToday = allLogs.filter(l => l.status === 'sent' && new Date(l.createdAt).toDateString() === today).length;

  let labels = [];
  let bucketFn;

  if (timeframe === '1D') {
    for (let h = 0; h < 24; h++) labels.push(`${String(h).padStart(2,'0')}:00`);
    const cutoff = new Date(now - 24*60*60*1000);
    bucketFn = (date) => date < cutoff ? null : date.getHours();
  } else if (timeframe === '1W') {
    for (let d = 6; d >= 0; d--) {
      const day = new Date(now); day.setDate(day.getDate() - d);
      labels.push(day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
    }
    const cutoff = new Date(now - 7*24*60*60*1000);
    bucketFn = (date) => { if (date < cutoff) return null; return 6 - Math.floor((now - date) / (24*60*60*1000)); };
  } else if (timeframe === '1M') {
    for (let d = 29; d >= 0; d--) {
      const day = new Date(now); day.setDate(day.getDate() - d);
      labels.push(day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    }
    const cutoff = new Date(now - 30*24*60*60*1000);
    bucketFn = (date) => { if (date < cutoff) return null; return 29 - Math.floor((now - date) / (24*60*60*1000)); };
  } else {
    for (let w = 25; w >= 0; w--) {
      const day = new Date(now); day.setDate(day.getDate() - w*7);
      labels.push(day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    }
    const cutoff = new Date(now - 26*7*24*60*60*1000);
    bucketFn = (date) => { if (date < cutoff) return null; return 25 - Math.floor((now - date) / (7*24*60*60*1000)); };
  }

  // Build per-user buckets
  const userData = {};
  Object.entries(users).forEach(([sid, u]) => {
    if (u.phone) userData[u.name || u.phone] = Array(labels.length).fill(0);
  });

  allLogs.filter(l => l.status === 'sent').forEach(l => {
    const date = new Date(l.createdAt);
    const idx = bucketFn(date);
    if (idx === null || idx < 0 || idx >= labels.length) return;
    const key = l.userName || 'Unknown';
    if (!userData[key]) userData[key] = Array(labels.length).fill(0);
    userData[key][idx]++;
  });

  res.json({
    totalUsers: Object.keys(users).filter(sid => sid !== db.SYSTEM_SESSION_ID).length,
    activeNow: Object.keys(clients).filter(wa.isConnected).length,
    sentToday,
    queueSize: queue.getQueue().length,
    chartLabels: labels,
    chartData: userData,
  });
});

module.exports = router;
