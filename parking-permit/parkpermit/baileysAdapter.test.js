// Run: node --test baileysAdapter.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBaileysClient, serialize, parseSerialized, statusToAck } = require('./baileysAdapter');

const GROUP = '120363041234567890@g.us';
const quiet = { error() {} };

// Fake Baileys socket: records sends, returns messages the way Baileys does (status PENDING = 1)
function fakeSock() {
  const sent = [];
  let n = 0;
  return {
    sent,
    sendMessage: async (jid, content, opts) => {
      const msg = { key: { remoteJid: jid, fromMe: true, id: `3EB0${String(++n).padStart(8, '0')}` }, status: 1 };
      sent.push({ jid, content, opts, msg });
      return msg;
    },
    groupFetchAllParticipating: async () => ({ [GROUP]: { id: GROUP, subject: 'Facilities Admin' } }),
  };
}

test('ids round-trip in whatsapp-web.js format; status maps to ack', () => {
  const key = { remoteJid: GROUP, fromMe: true, id: '3EB0ABCDEF12' };
  assert.equal(serialize(key), `true_${GROUP}_3EB0ABCDEF12`);
  assert.deepEqual(parseSerialized(serialize(key)), key);
  assert.equal(parseSerialized('nonsense'), null);
  assert.deepEqual([0, 1, 2, 3, 4].map(statusToAck), [-1, 0, 1, 2, 3]);
});

test('sendText returns { id, ack }; ack rises with messages.update and listeners fire', async () => {
  const sock = fakeSock();
  const client = createBaileysClient({ getSocket: () => sock, log: quiet });
  const heard = [];
  client.on('message_ack', (m, ack) => heard.push([m.id._serialized, ack]));

  const m = await client.sendText('60111111111@s.whatsapp.net', 'hello');
  assert.equal(sock.sent[0].content.text, 'hello');
  assert.match(m.id._serialized, /^true_60111111111@s\.whatsapp\.net_3EB0/);
  assert.equal(m.ack, 0);

  client.handleUpdates([{ key: sock.sent[0].msg.key, update: { status: 2 } }]);
  assert.equal(m.ack, 1, 'ack getter reads the live value');
  assert.deepEqual(heard, [[m.id._serialized, 1]]);

  client.handleUpdates([{ key: sock.sent[0].msg.key, update: { status: 2 } }]);
  assert.equal(heard.length, 1, 'repeated status is not re-announced');
  client.handleUpdates([{ key: sock.sent[0].msg.key, update: { status: 1 } }]);
  assert.equal(m.ack, 1, 'acks never go backwards');
});

test('a server ack that arrives before the send resolves is not lost', async () => {
  const sock = fakeSock();
  let client;
  const orig = sock.sendMessage;
  sock.sendMessage = async (...a) => {
    const msg = await orig(...a);
    client.handleUpdates([{ key: msg.key, update: { status: 2 } }]);   // ack lands first
    return msg;
  };
  client = createBaileysClient({ getSocket: () => sock, log: quiet });
  const m = await client.sendText('60111111111@s.whatsapp.net', 'fast');
  assert.equal(m.ack, 1);
});

test('sendFile sends the PDF as a document with caption and file name', async () => {
  const sock = fakeSock();
  const client = createBaileysClient({ getSocket: () => sock, log: quiet });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bad-')), 'PP-0001.pdf');
  fs.writeFileSync(file, '%PDF-1.4 x');
  await client.sendFile('60111111111@s.whatsapp.net', file, 'Your letter');
  const c = sock.sent[0].content;
  assert.equal(c.mimetype, 'application/pdf');
  assert.equal(c.fileName, 'PP-0001.pdf');
  assert.equal(c.caption, 'Your letter');
  assert.equal(c.document.toString(), '%PDF-1.4 x');
});

test('deleteMessage turns a stored id back into a delete-for-everyone key', async () => {
  const sock = fakeSock();
  const client = createBaileysClient({ getSocket: () => sock, log: quiet });
  await client.deleteMessage(`true_${GROUP}_3EB0ABCDEF12`);
  assert.deepEqual(sock.sent[0], { jid: GROUP, content: { delete: { remoteJid: GROUP, fromMe: true, id: '3EB0ABCDEF12' } },
                                   opts: undefined, msg: sock.sent[0].msg });
  await assert.rejects(client.deleteMessage('garbage'), /unrecognised/);
});

test('wrapIncoming: DM text, ephemeral wrapper, and reply quotes the original', async () => {
  const sock = fakeSock();
  const client = createBaileysClient({ getSocket: () => sock, log: quiet });
  const raw = { key: { remoteJid: '60111111111@s.whatsapp.net', fromMe: false, id: 'ABC' },
                message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'PERMIT\nName: A' } } } } };
  const m = client.wrapIncoming(raw);
  assert.equal(m.from, '60111111111@s.whatsapp.net');
  assert.equal(m.author, undefined);
  assert.equal(m.fromMe, false);
  assert.equal(m.body, 'PERMIT\nName: A');
  assert.equal(m.hasQuotedMsg, false);
  await m.reply('ok');
  assert.equal(sock.sent[0].opts.quoted, raw);
  assert.equal(client.wrapIncoming({ key: raw.key, message: { conversation: 'hi' } }).body, 'hi');
});

test('wrapIncoming: group command with quote, @lid author and phone number from participantPn', async () => {
  const client = createBaileysClient({ getSocket: () => fakeSock(), log: quiet });
  const m = client.wrapIncoming({
    key: { remoteJid: GROUP, fromMe: false, id: 'XYZ', participant: '987654321098765@lid', participantPn: '60123456789@s.whatsapp.net' },
    message: { extendedTextMessage: { text: 'APPROVE Bay B2', contextInfo: { stanzaId: '3EB0ABCDEF12', participant: '60199999999@s.whatsapp.net' } } },
  });
  assert.equal(m.from, GROUP);
  assert.equal(m.author, '987654321098765@lid');
  assert.equal(m.hasQuotedMsg, true);
  assert.deepEqual(await m.getQuotedMessage(), { id: { _serialized: `true_${GROUP}_3EB0ABCDEF12`, id: '3EB0ABCDEF12' } });
  assert.deepEqual(await m.getContact(), { number: '60123456789' });
});

test('getChats lists groups for logGroups / the admin page', async () => {
  const client = createBaileysClient({ getSocket: () => fakeSock(), log: quiet });
  assert.deepEqual(await client.getChats(), [{ isGroup: true, name: 'Facilities Admin', id: { _serialized: GROUP } }]);
});

test('no socket (disconnected) → sends fail with a clear error', async () => {
  const client = createBaileysClient({ getSocket: () => null, log: quiet });
  await assert.rejects(client.sendText('x@s.whatsapp.net', 'hi'), /WhatsApp not connected/);
});
