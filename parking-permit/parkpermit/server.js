// server.js — the parking permit app: one WhatsApp number + its admin page (office LAN).
//
//   node server.js            (PM2: pm2 start ecosystem.config.js)
//
// Config: .env next to this file (see .env.example). Data: ./data (PERMIT_DATA_DIR to move it):
//   permit.db  settings.json  auth/ (WhatsApp login)  letters/ (PDFs until purge)  letterhead/ (logo, map)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { load } = require('./deps');

load('dotenv').config({ path: path.join(__dirname, '.env') });

const express = load('express');
const jwt = load('jsonwebtoken');
const { validate: validateSettings } = require('./settings');

const IMAGE_LIMITS = { logo: 1024 * 1024, map: 3 * 1024 * 1024 };
const DEFAULT_PASSWORDS = ['admin', 'admin123', 'password', 'changeme'];

// File type from the bytes, never from the client's file name
function sniffImage(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ext: '.png', type: 'image/png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg', type: 'image/jpeg' };
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { ext: '.webp', type: 'image/webp' };
  return null;
}

function adminConfigError(env) {
  const { PERMIT_ADMIN_USER, PERMIT_ADMIN_PASSWORD, PERMIT_JWT_SECRET } = env;
  if (!PERMIT_ADMIN_USER || !PERMIT_ADMIN_PASSWORD || !PERMIT_JWT_SECRET) {
    return 'PERMIT_ADMIN_USER, PERMIT_ADMIN_PASSWORD and PERMIT_JWT_SECRET must be set in .env';
  }
  if (DEFAULT_PASSWORDS.includes(PERMIT_ADMIN_PASSWORD) || PERMIT_ADMIN_PASSWORD.length < 8) return 'PERMIT_ADMIN_PASSWORD is too weak (8+ characters, not a default)';
  if (PERMIT_JWT_SECRET.length < 32) return 'PERMIT_JWT_SECRET must be at least 32 random characters';
  return null;
}

const safeEqual = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest());

// ─── Admin API ───────────────────────────────────────────────────
// deps: { settings, workflow, client, connection, dataDir, chromePath, env, log }
function createApp({ settings, workflow, client, connection, dataDir, chromePath, env = process.env, log = console }) {
  const app = express();
  const imageDir = path.join(dataDir, 'letterhead');
  const configError = adminConfigError(env);
  if (configError) log.error(`[permit] admin login disabled: ${configError}`);

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    });
    next();
  });
  app.use(express.json({ limit: '6mb' }));   // base64 map upload (3 MB → ~4 MB)

  // ── login (5 failures per IP in 15 min → 15 min lock) ──
  const failures = new Map();
  const WINDOW = 15 * 60_000;
  app.post('/api/login', (req, res) => {
    if (configError) return res.status(503).json({ error: 'Admin login is disabled until the server is configured' });
    const ip = req.ip;
    const f = failures.get(ip);
    if (f && f.lockedUntil > Date.now()) {
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil((f.lockedUntil - Date.now()) / 60000)} min.` });
    }
    const { username, password } = req.body || {};
    const ok = [safeEqual(username || '', env.PERMIT_ADMIN_USER), safeEqual(password || '', env.PERMIT_ADMIN_PASSWORD)].every(Boolean);
    if (!ok) {
      const cur = f && Date.now() - f.first < WINDOW ? f : { count: 0, first: Date.now(), lockedUntil: 0 };
      cur.count++;
      if (cur.count >= 5) cur.lockedUntil = Date.now() + WINDOW;
      failures.set(ip, cur);
      log.warn(`[permit] admin login failed from ${ip}`);
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    failures.delete(ip);
    res.json({ token: jwt.sign({ admin: true }, env.PERMIT_JWT_SECRET, { algorithm: 'HS256', expiresIn: '12h' }) });
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));   // container health check (no auth, no data)

  // Everything below needs a valid admin token
  app.use('/api', (req, res, next) => {
    if (configError) return res.status(503).json({ error: 'Admin access is disabled (server not configured)' });
    const h = req.headers.authorization || '';
    try {
      const t = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', env.PERMIT_JWT_SECRET, { algorithms: ['HS256'] });
      if (!t.admin) throw new Error('not admin');
      next();
    } catch {
      res.status(401).json({ error: 'Please sign in' });
    }
  });

  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    log.error(`[permit] ${req.method} ${req.path} failed:`, e.message);
    res.status(500).json({ error: e.message });
  });

  // Settings as the page sees them: image paths stay server-side
  function publicSettings() {
    const s = settings.get();
    const { logo_path: logo, map_path: map, ...letterhead } = s.letterhead;
    return { ...s, letterhead: { ...letterhead, has_logo: !!logo && fs.existsSync(logo), has_map: !!map && fs.existsSync(map) } };
  }

  app.get('/api/status', (req, res) => {
    const s = settings.get();
    res.json({
      whatsapp: connection.status(),
      chrome: !!chromePath,
      group_set: !!s.admin_group_id,
      approvers: s.admin_approvers.length,
      pending: workflow.approvals.listLog({ status: 'PENDING', limit: 1 }).total,
    });
  });

  app.post('/api/whatsapp/pair', (req, res) => { connection.pair(); res.json(connection.status()); });
  app.post('/api/whatsapp/unlink', wrap(async (req, res) => { await connection.unlink(); res.json(connection.status()); }));

  // Groups the bot is in, to pick the admin group from
  app.get('/api/groups', wrap(async (req, res) => {
    if (connection.status().state !== 'open') return res.status(409).json({ error: 'WhatsApp is not connected' });
    const chats = await client.getChats();
    res.json(chats.filter(c => c.isGroup).map(c => ({ id: c.id._serialized, name: c.name }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))));
  }));

  app.get('/api/settings', (req, res) => res.json(publicSettings()));

  app.put('/api/settings', (req, res) => {
    const result = settings.save(req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.errors.join('; '), errors: result.errors });
    res.json(publicSettings());
  });

  // ── letterhead images: base64 JSON upload, type from magic bytes, server-chosen file name ──
  app.post('/api/images/:kind', wrap(async (req, res) => {
    const { kind } = req.params;
    if (!IMAGE_LIMITS[kind]) return res.status(404).json({ error: 'Unknown image' });
    const buf = Buffer.from(String(req.body?.data || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length) return res.status(400).json({ error: 'No image data' });
    if (buf.length > IMAGE_LIMITS[kind]) return res.status(400).json({ error: `${kind === 'logo' ? 'Logo' : 'Map'} must be ${IMAGE_LIMITS[kind] / 1048576} MB or smaller` });
    const t = sniffImage(buf);
    if (!t) return res.status(400).json({ error: 'Only PNG, JPG or WEBP images are allowed' });

    await fs.promises.mkdir(imageDir, { recursive: true });
    const finalPath = path.join(imageDir, `${kind}${t.ext}`);
    const tmp = `${finalPath}.tmp`;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, finalPath);
    for (const ext of ['.png', '.jpg', '.webp']) {
      if (ext !== t.ext) await fs.promises.unlink(path.join(imageDir, `${kind}${ext}`)).catch(() => {});
    }
    settings.setImage(kind, finalPath);
    res.json(publicSettings());
  }));

  app.delete('/api/images/:kind', wrap(async (req, res) => {
    const { kind } = req.params;
    if (!IMAGE_LIMITS[kind]) return res.status(404).json({ error: 'Unknown image' });
    const p = settings.get().letterhead[`${kind}_path`];
    if (p && path.dirname(p) === imageDir) await fs.promises.unlink(p).catch(() => {});
    settings.setImage(kind, '');
    res.json(publicSettings());
  }));

  app.get('/api/images/:kind', (req, res) => {
    const { kind } = req.params;
    const p = IMAGE_LIMITS[kind] && settings.get().letterhead[`${kind}_path`];
    if (!p || !fs.existsSync(p)) return res.status(404).end();
    const t = sniffImage(fs.readFileSync(p));
    if (!t) return res.status(404).end();
    res.type(t.type).set('Cache-Control', 'no-store').sendFile(p);
  });

  // Letter preview from sample data and the (unsaved) letterhead in the form
  app.post('/api/preview', wrap(async (req, res) => {
    if (!chromePath) return res.status(409).json({ error: 'Chrome was not found on this server (set CHROME_PATH)' });
    const { errors, value } = validateSettings({ letterhead: req.body?.letterhead || {} });
    if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });
    const cur = settings.get().letterhead;
    const pdf = await workflow.letters.previewLetter({ ...cur, ...value.letterhead });
    res.type('application/pdf').set('Cache-Control', 'no-store').send(pdf);
  }));

  // Request log: approval_log only (no applicant details)
  app.get('/api/log', (req, res) => {
    try {
      res.json(workflow.approvals.listLog({ status: req.query.status || null, limit: req.query.limit, offset: req.query.offset }));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(path.join(__dirname, 'admin'), { index: 'index.html' }));
  return app;
}

// ─── Startup ─────────────────────────────────────────────────────
function main() {
  const Database = load('better-sqlite3');
  const { createSettingsStore } = require('./settings');
  const { createPdfRenderer, findChrome } = require('./pdf');
  const { createBaileysClient } = require('./baileysAdapter');
  const { createConnection } = require('./connection');
  const { createPermitWorkflow } = require('./permitWorkflow');

  const dataDir = path.resolve(process.env.PERMIT_DATA_DIR || path.join(__dirname, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, 'permit.db'));
  db.pragma('journal_mode = WAL');
  const settings = createSettingsStore(path.join(dataDir, 'settings.json'));

  const chromePath = findChrome();
  if (chromePath) console.log(`[permit] PDF renderer: ${chromePath}`);
  else console.error('[permit] Chrome not found: approval letters cannot be rendered. Set CHROME_PATH in .env');

  let connection = null;
  const client = createBaileysClient({ getSocket: () => connection && connection.getSocket() });
  const workflow = createPermitWorkflow({
    client, db, getSettings: settings.get,
    outDir: path.join(dataDir, 'letters'),
    renderPdf: createPdfRenderer({ chromePath }),
  });
  connection = createConnection({
    authDir: path.join(dataDir, 'auth'),
    onOpen: () => workflow.onReady(),
    onClose: () => workflow.stop(),
    onUpdates: updates => client.handleUpdates(updates),
    onMessages: ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) workflow.handleMessage(client.wrapIncoming(m));
    },
  });

  const app = createApp({ settings, workflow, client, connection, dataDir, chromePath });
  const port = Number(process.env.PERMIT_PORT) || 5100;
  const host = process.env.PERMIT_HOST || '0.0.0.0';
  const server = app.listen(port, host, () => console.log(`[permit] admin page on http://${host}:${port}`));

  connection.start();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    workflow.stop();
    await connection.stop();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createApp, sniffImage, adminConfigError };
