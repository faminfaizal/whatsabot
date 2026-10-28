// baileysAdapter.js — gives the permit modules (written against whatsapp-web.js shapes) a Baileys socket.
//
//   const client = createBaileysClient({ getSocket: () => connection.getSocket() });
//   sock.ev.on('messages.update', updates => client.handleUpdates(updates));      // acks
//   sock.ev.on('messages.upsert', ({ messages, type }) => type === 'notify' &&
//     messages.forEach(m => workflow.handleMessage(client.wrapIncoming(m))));
//
// What it maps:
//   message ids    Baileys key {remoteJid, fromMe, id}  ↔  "true_<remoteJid>_<id>" (whatsapp-web.js format,
//                  so a stored group_msg_id can be turned back into a key for "delete for everyone")
//   acks           Baileys status ERROR 0 / PENDING 1 / SERVER_ACK 2 / DELIVERY 3 / READ 4
//                  → whatsapp-web.js ack -1 / 0 / 1 / 2 / 3   (delivery.js waits for ack ≥ 1)
//   incoming msg   { from, fromMe, author, body, hasQuotedMsg, getQuotedMessage(), getContact(), reply() }
// getSocket() is called on every use: Baileys makes a new socket on each reconnect.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ACK_CACHE = 500;   // recent acks kept so a fast server ack isn't missed before anyone waits

const serialize = key => `${key.fromMe ? 'true' : 'false'}_${key.remoteJid}_${key.id}`;

function parseSerialized(s) {
  const m = String(s || '').match(/^(true|false)_(.+@[a-z.]+)_([^_]+)$/);
  return m ? { fromMe: m[1] === 'true', remoteJid: m[2], id: m[3] } : null;
}

const statusToAck = status => (status === 0 ? -1 : (typeof status === 'number' ? status - 1 : 0));

// Unwraps ephemeral / view-once containers
function innerMessage(m) {
  let c = m?.message || {};
  for (let i = 0; i < 3; i++) {
    const next = c.ephemeralMessage?.message || c.viewOnceMessage?.message || c.viewOnceMessageV2?.message
      || c.documentWithCaptionMessage?.message;
    if (!next) break;
    c = next;
  }
  return c;
}

function textOf(c) {
  return c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption
    || c.videoMessage?.caption || c.documentMessage?.caption || '';
}

function contextOf(c) {
  return c.extendedTextMessage?.contextInfo || c.imageMessage?.contextInfo
    || c.videoMessage?.contextInfo || c.documentMessage?.contextInfo || null;
}

const digitsOf = jid => (String(jid || '').match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/) || [])[1] || '';

function createBaileysClient({ getSocket, log = console }) {
  const ackListeners = new Set();
  const acks = new Map();   // serialized id → latest ack

  function sock() {
    const s = getSocket();
    if (!s) throw new Error('WhatsApp not connected');
    return s;
  }

  function rememberAck(id, ack) {
    acks.delete(id);
    acks.set(id, ack);
    if (acks.size > ACK_CACHE) acks.delete(acks.keys().next().value);
  }

  // A sent Baileys message as whatsapp-web.js shapes it; ack reads the live cache
  function wrapSent(sent) {
    if (!sent?.key?.id) throw new Error('send returned no message');
    const id = serialize(sent.key);
    if (!acks.has(id)) rememberAck(id, statusToAck(sent.status));
    return {
      id: { _serialized: id, id: sent.key.id },
      get ack() { return acks.get(id) ?? 0; },
    };
  }

  // Feed sock.ev 'messages.update' here
  function handleUpdates(updates) {
    for (const u of updates || []) {
      if (!u?.key?.id || typeof u.update?.status !== 'number') continue;
      const id = serialize(u.key);
      const ack = statusToAck(u.update.status);
      if ((acks.get(id) ?? -2) >= ack && ack !== -1) continue;   // acks only move forward
      rememberAck(id, ack);
      for (const fn of ackListeners) {
        try { fn({ id: { _serialized: id, id: u.key.id } }, ack); } catch (e) { log.error('[permit] ack listener:', e.message); }
      }
    }
  }

  async function sendText(jid, text) {
    return wrapSent(await sock().sendMessage(jid, { text }));
  }

  async function sendFile(jid, filePath, caption) {
    const document = await fs.promises.readFile(filePath);
    return wrapSent(await sock().sendMessage(jid, {
      document, mimetype: 'application/pdf', fileName: path.basename(filePath), caption,
    }));
  }

  // "Delete for everyone" for a message this bot sent, by its serialized id
  async function deleteMessage(serializedId) {
    const key = parseSerialized(serializedId);
    if (!key) throw new Error('unrecognised message id');
    await sock().sendMessage(key.remoteJid, { delete: { ...key, fromMe: true } });
  }

  // Incoming Baileys message → the shape intake.js / approvalListener.js expect
  function wrapIncoming(m) {
    const key = m.key || {};
    const c = innerMessage(m);
    const ctx = contextOf(c);
    const isGroup = String(key.remoteJid || '').endsWith('@g.us');
    const author = isGroup ? (key.participant || '') : undefined;
    return {
      id: { _serialized: serialize(key), id: key.id },
      from: key.remoteJid,
      fromMe: !!key.fromMe,
      author,
      body: textOf(c),
      hasQuotedMsg: !!ctx?.stanzaId,
      // Matched by the quoted message's own id; the listener falls back to id.id
      getQuotedMessage: async () => (ctx?.stanzaId
        ? { id: { _serialized: `true_${key.remoteJid}_${ctx.stanzaId}`, id: ctx.stanzaId } }
        : null),
      // Phone number when WhatsApp hides the sender behind a @lid
      getContact: async () => ({
        number: digitsOf(key.participantPn) || digitsOf(key.senderPn) || digitsOf(author || key.remoteJid),
      }),
      reply: async text => wrapSent(await sock().sendMessage(key.remoteJid, { text }, { quoted: m })),
    };
  }

  return {
    // whatsapp-web.js-style surface used by delivery.createAckWaiter and adminGroup.logGroups
    on(event, fn) { if (event === 'message_ack') ackListeners.add(fn); },
    getMessageById: async () => null,   // Baileys keeps no message store; ack waiter relies on events
    sendMessage: (jid, text) => sendText(jid, text),
    async getChats() {
      const groups = await sock().groupFetchAllParticipating();
      return Object.values(groups).map(g => ({ isGroup: true, name: g.subject, id: { _serialized: g.id } }));
    },
    // Baileys-specific
    sendText, sendFile, deleteMessage, wrapIncoming, handleUpdates,
  };
}

module.exports = { createBaileysClient, serialize, parseSerialized, statusToAck };
