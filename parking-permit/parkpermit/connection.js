// connection.js — keeps the permit bot's one WhatsApp number connected (Baileys).
//
//   const conn = createConnection({ authDir, onOpen, onClose, onMessages, onUpdates });
//   conn.start();            // on boot: reconnects with saved credentials, or waits for pairing
//   conn.pair();             // admin page "Link WhatsApp": produces QR codes (conn.status().qr)
//   conn.getSocket();        // current socket while open, else null
//
// States: 'idle' (not linked, waiting for an admin to pair) → 'connecting' → 'qr' → 'open'.
// A linked bot reconnects forever with back-off (5 s → 5 min). Unpaired QR attempts stop after 3
// rounds and go back to 'idle' until an admin asks again. If the phone unlinks the bot
// (loggedOut), its credentials are deleted and the state returns to 'idle'.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./deps');

const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_QR_ROUNDS = 3;
const FALLBACK_VERSION = [2, 3000, 1015901307];

function createConnection({ authDir, onOpen = () => {}, onClose = () => {}, onMessages = () => {},
                            onUpdates = () => {}, log = console, baileys = load('@whiskeysockets/baileys'),
                            qrcode = load('qrcode'), logger = load('pino')({ level: 'silent' }) }) {
  const makeWASocket = baileys.default || baileys.makeWASocket;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

  let sock = null;
  let state = 'idle';
  let qrDataUrl = null;
  let me = null;          // { phone, name } once open
  let attempts = 0;
  let qrRounds = 0;
  let timer = null;
  let stopped = false;
  let lastError = null;

  const isLinked = () => fs.existsSync(path.join(authDir, 'creds.json'))
    && (() => { try { return !!JSON.parse(fs.readFileSync(path.join(authDir, 'creds.json'), 'utf8')).me; } catch { return false; } })();

  async function latestVersion() {
    // The server has no internet; don't let the version lookup hold up connecting
    try {
      const r = await Promise.race([fetchLatestBaileysVersion(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
      return r.version;
    } catch { return FALLBACK_VERSION; }
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(connect, ms);
  }

  async function connect() {
    if (stopped || sock) return;
    state = 'connecting';
    qrDataUrl = null;
    try {
      fs.mkdirSync(authDir, { recursive: true });
      const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
      const s = makeWASocket({
        version: await latestVersion(), auth, logger,
        browser: ['Parking Permit Bot', 'Chrome', '1.0.0'],
        syncFullHistory: false, markOnlineOnConnect: false, connectTimeoutMs: 60_000,
      });
      sock = s;
      s.ev.on('creds.update', saveCreds);
      s.ev.on('messages.upsert', e => { if (sock === s) onMessages(e); });
      s.ev.on('messages.update', u => { if (sock === s) onUpdates(u); });
      s.ev.on('connection.update', u => handleUpdate(s, u));
    } catch (e) {
      lastError = e.message;
      log.error('[permit] connect failed:', e.message);
      sock = null;
      retry();
    }
  }

  async function handleUpdate(s, { connection, lastDisconnect, qr }) {
    if (sock !== s) return;   // an old socket's late event
    if (qr) {
      state = 'qr';
      try { qrDataUrl = await qrcode.toDataURL(qr); } catch { qrDataUrl = null; }
    }
    if (connection === 'open') {
      state = 'open';
      qrDataUrl = null;
      attempts = 0;
      qrRounds = 0;
      lastError = null;
      const raw = s.user?.id || '';
      me = { phone: raw.split(':')[0].split('@')[0], name: s.user?.name || '' };
      log.log(`[permit] WhatsApp connected as +${me.phone}`);
      try { await onOpen(); } catch (e) { log.error('[permit] onOpen failed:', e.message); }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const wasOpen = state === 'open';
      sock = null;
      qrDataUrl = null;
      if (wasOpen) { try { onClose(); } catch (e) { log.error('[permit] onClose failed:', e.message); } }
      log.warn(`[permit] WhatsApp disconnected (code ${code})`);

      if (code === DisconnectReason.loggedOut) {
        // The bot was unlinked from the phone: its credentials are dead
        fs.rmSync(authDir, { recursive: true, force: true });
        state = 'idle';
        me = null;
        lastError = 'Unlinked from the phone. Link WhatsApp again from the admin page.';
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        state = 'idle';
        lastError = 'Another process opened this WhatsApp session. Stop it, then reconnect from the admin page.';
        return;
      }
      if (code === DisconnectReason.restartRequired) return schedule(0);   // normal right after pairing
      retry();
    }
  }

  function retry() {
    if (stopped) return;
    if (!isLinked()) {
      // Pairing in progress: each QR round lasts about a minute; stop after a few
      if (++qrRounds >= MAX_QR_ROUNDS) {
        state = 'idle';
        qrRounds = 0;
        lastError = 'QR code not scanned in time. Click "Link WhatsApp" to try again.';
        return;
      }
      state = 'connecting';
      return schedule(2000);
    }
    attempts++;
    state = 'connecting';
    const delay = Math.min(5000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
    log.log(`[permit] reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts})`);
    schedule(delay);
  }

  return {
    // On boot: connect only if already linked; otherwise wait for an admin to pair
    start() {
      stopped = false;
      if (isLinked()) connect();
      else log.log('[permit] WhatsApp not linked yet. Open the admin page and click "Link WhatsApp".');
    },
    pair() {
      stopped = false;
      qrRounds = 0;
      lastError = null;
      if (!sock) { clearTimeout(timer); connect(); }
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      const s = sock;
      sock = null;
      if (s) { try { s.end(undefined); } catch {} }
    },
    // Unlink the bot from its phone (admin action)
    async unlink() {
      const s = sock;
      if (s) { try { await s.logout(); } catch {} }
      sock = null;
      fs.rmSync(authDir, { recursive: true, force: true });
      state = 'idle';
      me = null;
    },
    getSocket: () => (state === 'open' ? sock : null),
    status: () => ({ state, qr: state === 'qr' ? qrDataUrl : null, phone: me?.phone || null, linked: isLinked(), error: lastError }),
  };
}

module.exports = { createConnection };
