const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');

// ─── Admin config ─────────────────────────────────────────────────
// No built-in fallbacks: if the credentials are missing or still the README defaults,
// admin login stays disabled until server/.env is fixed.

const DEFAULT_PASSWORDS = ['admin123'];
const DEFAULT_SECRETS = ['secret', 'changeme'];

function adminConfigError() {
  const { ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_JWT_SECRET } = process.env;
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !ADMIN_JWT_SECRET) {
    return 'ADMIN_USERNAME, ADMIN_PASSWORD and ADMIN_JWT_SECRET must be set in server/.env';
  }
  if (DEFAULT_PASSWORDS.includes(ADMIN_PASSWORD)) return 'ADMIN_PASSWORD is still the default';
  if (DEFAULT_SECRETS.includes(ADMIN_JWT_SECRET)) return 'ADMIN_JWT_SECRET is still the default';
  return null;
}

// Constant-time string compare (hash first so lengths match)
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkAdminCredentials(username, password) {
  if (adminConfigError()) return false;
  // Evaluate both so a wrong username takes as long as a wrong password
  const userOk = safeEqual(username || '', process.env.ADMIN_USERNAME);
  const passOk = safeEqual(password || '', process.env.ADMIN_PASSWORD);
  return userOk && passOk;
}

function signAdminToken() {
  return jwt.sign({ admin: true }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256', expiresIn: '24h' });
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function adminAuth(req, res, next) {
  if (adminConfigError()) return res.status(503).json({ error: 'Admin access is disabled (server not configured)' });
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET, { algorithms: ['HS256'] });
    if (!decoded.admin) throw new Error('not admin');
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── Admin login lockout ──────────────────────────────────────────
// 5 failures from one IP within 15 min → locked for 15 min (in memory; resets on restart).

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map(); // ip → { count, first, lockedUntil }

function loginLockedFor(ip) {
  const f = loginFailures.get(ip);
  if (!f) return 0;
  const now = Date.now();
  if (f.lockedUntil && f.lockedUntil > now) return f.lockedUntil - now;
  if (now - f.first > WINDOW_MS) loginFailures.delete(ip);
  return 0;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const f = loginFailures.get(ip);
  if (!f || now - f.first > WINDOW_MS) {
    loginFailures.set(ip, { count: 1, first: now, lockedUntil: 0 });
    return;
  }
  f.count++;
  if (f.count >= MAX_FAILURES) f.lockedUntil = now + WINDOW_MS;
}

function clearLoginFailures(ip) { loginFailures.delete(ip); }

// ─── User auth ────────────────────────────────────────────────────
// The browser sends its session token; the session is taken from the token, never from the URL
// or body. A :sessionId param or body.sessionId must match it.

function userAuth(req, res, next) {
  const sessionId = db.getSessionIdByToken(bearer(req));
  if (!sessionId) return res.status(401).json({ error: 'Not signed in' });
  const claimed = req.params.sessionId || req.body?.sessionId;
  if (claimed && claimed !== sessionId) return res.status(403).json({ error: 'Forbidden' });
  req.sessionId = sessionId;
  next();
}

module.exports = {
  adminAuth, userAuth, bearer,
  adminConfigError, checkAdminCredentials, signAdminToken,
  loginLockedFor, recordLoginFailure, clearLoginFailures,
};
