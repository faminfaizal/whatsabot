const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const db = require('./db');

const clients = {};
const creating = {};
const reconnectAttempts = {};          // sessionId → consecutive failed connects (in memory)
const retired = new Set();             // sessions merged into another; never reconnect them
const MAX_UNLINKED_ATTEMPTS = 3;       // QR never scanned: stop generating QRs after this
const MAX_BACKOFF_MS = 5 * 60 * 1000;  // linked sessions retry forever, backing off to 5 min
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let io = null;
let onReadyHook = null;

function setIO(socketIO) { io = socketIO; }
function setOnReady(fn) { onReadyHook = fn; }
function getClient(sessionId) { return clients[sessionId] || null; }
function getAllClients() { return clients; }
// True only once the socket has opened (a client entry exists while it is still connecting)
function isConnected(sessionId) { return !!clients[sessionId]?.ready; }

// Logged-out credentials can never reconnect; clear them so the next start shows a fresh QR
function clearAuth(sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) return;
  try {
    fs.rmSync(path.join(__dirname, 'sessions', sessionId, 'auth'), { recursive: true, force: true });
    console.log(`🗑  Cleared logged-out credentials for ${sessionId}`);
  } catch (e) {
    console.error(`Could not clear credentials for ${sessionId}:`, e.message);
  }
}

// Merges full or partial Baileys contacts ({ id, name?, notify?, subject? }) into the session cache
function mergeContacts(sessionId, contacts) {
  const byId = {};
  db.getUserContacts(sessionId).forEach(c => { byId[c.id] = c; });
  for (const c of contacts) {
    if (!c?.id || !(c.id.endsWith('@s.whatsapp.net') || c.id.endsWith('@g.us'))) continue;
    const prev = byId[c.id];
    const number = c.id.split('@')[0];
    byId[c.id] = {
      id: c.id,
      name: c.name || c.subject || c.notify || prev?.name || number,
      number,
      isGroup: c.id.endsWith('@g.us'),
      isMyContact: !!c.name || !!prev?.isMyContact,
    };
  }
  const merged = Object.values(byId).filter(c => c.name);
  db.saveUserContacts(sessionId, merged);
  return merged;
}

// Baileys has no address-book API: contacts arrive via events. Refresh re-reads the groups.
async function refreshContacts(sessionId) {
  const client = clients[sessionId];
  if (client?.ready) {
    try {
      const groups = await client.socket.groupFetchAllParticipating();
      mergeContacts(sessionId, Object.values(groups).map(g => ({ id: g.id, subject: g.subject })));
    } catch (e) {
      console.error(`Group fetch failed for ${sessionId}:`, e.message);
    }
  }
  return db.getUserContacts(sessionId);
}

const logger = pino({ level: 'silent' });

async function createClient(sessionId) {
  if (retired.has(sessionId)) return null;
  if (clients[sessionId]?.socket) {
    console.log(`Client already exists for ${sessionId}`);
    return clients[sessionId];
  }
  if (creating[sessionId]) {
    console.log(`Already creating ${sessionId}, skipping`);
    return null;
  }
  creating[sessionId] = true;

  console.log(`\n🔌 Creating Baileys client for: ${sessionId}`);

  try {
    const sessionDir = path.join(__dirname, 'sessions', sessionId, 'auth');
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    let version;
    try {
      const result = await fetchLatestBaileysVersion();
      version = result.version;
      console.log(`📱 WA version: ${version.join('.')}`);
    } catch {
      version = [2, 3000, 1015901307];
      console.log('📱 Using fallback WA version');
    }

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: ['WA Messenger', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
    });

    clients[sessionId] = { socket: sock };

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      console.log('connection.update:', JSON.stringify({ connection, hasQR: !!qr }));

      if (qr) {
        console.log(`✅ QR received for ${sessionId}`);
        try {
          const qrDataURL = await qrcode.toDataURL(qr);
          // Only to this session's room — a QR must never reach another browser
          if (io) io.to(sessionId).emit('qr', qrDataURL);
        } catch (e) {
          console.error('QR toDataURL error:', e.message);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`❌ Disconnected ${sessionId} code:${statusCode}`);

        // Only drop the entry if it is still this socket (a newer one may have replaced it)
        if (clients[sessionId]?.socket === sock) delete clients[sessionId];

        const existingUser = db.getUser(sessionId);
        const linked = !!existingUser?.phone;
        if (linked) {
          db.saveUser(sessionId, { status: 'disconnected', lastSeen: new Date().toISOString() });
        } else if (existingUser) {
          // No valid phone — ghost session, remove it entirely
          const allUsers = db.getUsers();
          delete allUsers[sessionId];
          db.saveUsers(allUsers);
          console.log(`🧹 Removed ghost session: ${sessionId}`);
        }
        if (io) io.to(sessionId).emit('disconnected', 'Connection closed');

        if (statusCode === DisconnectReason.loggedOut) {
          // Unlinked from the phone: credentials are dead. Don't reconnect or auto-restore.
          delete reconnectAttempts[sessionId];
          clearAuth(sessionId);
          if (linked) db.saveUser(sessionId, { status: 'logged_out' });
          return;
        }
        if (statusCode === DisconnectReason.connectionReplaced) {
          // Another process opened these same credentials; reconnecting would fight it
          delete reconnectAttempts[sessionId];
          console.log(`🛑 ${sessionId}: connection replaced elsewhere, not reconnecting`);
          return;
        }
        if (statusCode === DisconnectReason.restartRequired) {
          // Normal right after a QR scan — reconnect at once, not a failure
          setTimeout(() => createClient(sessionId), 0);
          return;
        }

        const attempt = (reconnectAttempts[sessionId] || 0) + 1;
        reconnectAttempts[sessionId] = attempt;
        if (!linked && attempt > MAX_UNLINKED_ATTEMPTS) {
          delete reconnectAttempts[sessionId];
          console.log(`🛑 ${sessionId}: QR not scanned after ${MAX_UNLINKED_ATTEMPTS} tries, stopping`);
          return;
        }
        const delay = linked ? Math.min(5000 * 2 ** (attempt - 1), MAX_BACKOFF_MS) : 5000;
        console.log(`🔄 Reconnecting ${sessionId} in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
        setTimeout(() => createClient(sessionId), delay);
      }

      if (connection === 'open') {
        console.log(`✅ Connected! Session: ${sessionId}`);
        if (clients[sessionId]?.socket === sock) clients[sessionId].ready = true;
        delete reconnectAttempts[sessionId];

        const rawId = sock.user?.id || '';
        const phone = rawId.split(':')[0] || rawId.split('@')[0] || sessionId;
        const name = sock.user?.name || phone;
        console.log(`👤 Logged in as: ${name} (+${phone})`);

        // Check if another session already has this phone number
        const allUsers = db.getUsers();
        const existingEntry = Object.entries(allUsers).find(
          ([sid, u]) => u.phone === phone && sid !== sessionId
        );

        let inheritedCredits = null;
        let mergeFrom = null;

        if (existingEntry) {
          const [oldSessionId, oldUser] = existingEntry;
          console.log(`⚠️ Duplicate phone ${phone} — merging old session ${oldSessionId} → ${sessionId}`);

          // Carry over credits from old session
          inheritedCredits = oldUser.credits;
          mergeFrom = oldSessionId;

          // Retire the old session first so a pending reconnect timer can't revive it
          retired.add(oldSessionId);
          delete reconnectAttempts[oldSessionId];

          // Destroy old live client if still connected
          if (clients[oldSessionId]?.socket) {
            try { await clients[oldSessionId].socket.logout(); } catch {}
            delete clients[oldSessionId];
            console.log(`🔌 Destroyed old client: ${oldSessionId}`);
          }
          clearAuth(oldSessionId);
          if (io) io.to(oldSessionId).emit('disconnected', 'Signed in from another browser');
        }

        let user = db.getUser(sessionId);
        if (!user) {
          user = db.createUser(sessionId, phone, name);
          // Apply inherited credits if merging
          if (inheritedCredits !== null) {
            db.saveUser(sessionId, { credits: inheritedCredits });
            user.credits = inheritedCredits;
          }
          db.addAdminLog({ type: 'new_user', message: `New user: ${name} (${phone})`, sessionId });
        } else {
          db.saveUser(sessionId, { phone, name, lastSeen: new Date().toISOString(), status: 'active' });
          user = db.getUser(sessionId);
        }

        // Move the old session's schedules only now that the new users row exists (FK on sessionId).
        // deleteUser also revokes the old session's browser tokens.
        if (mergeFrom) {
          const oldSchedules = db.getUserSchedules(mergeFrom);
          if (oldSchedules.length > 0) {
            db.saveUserSchedules(sessionId, [...db.getUserSchedules(sessionId), ...oldSchedules]);
            console.log(`📅 Transferred ${oldSchedules.length} schedules to new session`);
          }
          db.deleteUser(mergeFrom);
          console.log(`🧹 Removed old session: ${mergeFrom}`);
        }

        if (io) io.to(sessionId).emit('ready', { phone, name, credits: user.credits });
        if (onReadyHook) onReadyHook(sessionId);   // e.g. let the queue send jobs that were waiting
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Cache contacts when received (full upserts, partial updates, and the initial history sync)
    const onContacts = (event, contacts) => {
      if (!contacts?.length) return;
      try {
        const merged = mergeContacts(sessionId, contacts);
        console.log(`✅ Contacts updated (${event}): ${merged.length} total`);
      } catch (e) {
        console.error(`${event} error:`, e.message);
      }
    };
    sock.ev.on('contacts.upsert', contacts => onContacts('contacts.upsert', contacts));
    sock.ev.on('contacts.update', contacts => onContacts('contacts.update', contacts));
    sock.ev.on('messaging-history.set', ({ contacts }) => onContacts('history', contacts));

  } catch (e) {
    console.error(`❌ createClient failed for ${sessionId}:`, e.message);
    console.error(e.stack);
    delete clients[sessionId];
  } finally {
    delete creating[sessionId];
  }

  return clients[sessionId];
}

async function sendMessage(sessionId, to, message) {
  const client = clients[sessionId];
  if (!client?.ready) throw new Error('Client not connected');

  const user = db.getUser(sessionId);
  if (!user) throw new Error('User not found');
  if (user.banned) throw new Error('Account is banned');
  if (user.credits <= 0) throw new Error('Insufficient credits');

  if (user.cooldownUntil && new Date() < new Date(user.cooldownUntil)) {
    throw new Error(`In cooldown until ${user.cooldownUntil}`);
  }

  const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;

  try {
    await client.socket.sendMessage(jid, { text: message });

    db.saveUser(sessionId, {
      credits: user.credits - 1,
      totalSent: (user.totalSent || 0) + 1,
      consecutiveFailures: 0,
      lastSeen: new Date().toISOString(),
    });

    db.addUserLog(sessionId, {
      to: jid, toDisplay: to,
      message: message.substring(0, 100),
      status: 'sent',
    });

    if (io) io.to(sessionId).emit('message_sent', { to, credits: user.credits - 1 });
    return true;

  } catch (err) {
    const failures = (user.consecutiveFailures || 0) + 1;
    const settings = db.getSettings();
    let cooldownUntil = null;
    if (failures >= settings.autoPauseFailures) {
      cooldownUntil = new Date(Date.now() + settings.cooldownMinutes * 60 * 1000).toISOString();
    }

    db.saveUser(sessionId, { consecutiveFailures: failures, cooldownUntil });
    db.addUserLog(sessionId, {
      to: jid, toDisplay: to,
      message: message.substring(0, 100),
      status: 'failed',
      error: err.message,
    });

    if (io) io.to(sessionId).emit('message_failed', { to, error: err.message });
    throw err;
  }
}

async function destroyClient(sessionId) {
  if (clients[sessionId]?.socket) {
    try { await clients[sessionId].socket.logout(); } catch {}
    delete clients[sessionId];
  }
}

// Reconnects every linked session on server start, so scheduled sends don't wait for a browser
async function initExistingSessions() {
  const users = db.getUsers();
  for (const sessionId of Object.keys(users)) {
    const user = users[sessionId];
    if (!SESSION_ID_RE.test(sessionId) || !user.phone) continue;   // skips the 'system' row
    if (!user.banned && user.status !== 'logged_out') {
      const sessionDir = path.join(__dirname, 'sessions', sessionId, 'auth');
      if (fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0) {
        console.log(`🔄 Restoring: ${user.name || sessionId}`);
        try { await createClient(sessionId); } catch (e) {
          console.error(`Restore failed:`, e.message);
        }
      }
    }
  }
}

module.exports = {
  setIO, setOnReady, getClient, getAllClients, isConnected,
  createClient, sendMessage, refreshContacts,
  destroyClient, initExistingSessions,
};
