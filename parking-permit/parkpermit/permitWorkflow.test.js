// Run: node --test permitWorkflow.test.js
// The real wiring (permitWorkflow + baileysAdapter) against a fake Baileys socket.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createBaileysClient } = require('./baileysAdapter');
const { createPermitWorkflow } = require('./permitWorkflow');

const GROUP = '120363041234567890@g.us';
const CLIENT = '60111111111@s.whatsapp.net';
const SITI_LID = '987654321098765@lid';
const SITI_PN = '60123456789@s.whatsapp.net';
const PII = ['Ahmad Faiz', 'WXY1234', 'WXY 1234', '60111111111', 'Night shift duty', 'Bay B2 only'];
const quiet = { log() {}, warn() {}, error() {} };

function world({ autoAck = true } = {}) {
  const db = new Database(':memory:');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  const settings = {
    admin_group_id: GROUP,
    approval_timeout_hours: 36,
    admin_approvers: [{ number: '012-345 6789', name: 'Siti Aminah' }],
    letterhead: { org_name: 'Menara Contoh' },
  };
  const sent = [];
  let n = 0, client;
  const sock = {
    sendMessage: async (jid, content, opts) => {
      const msg = { key: { remoteJid: jid, fromMe: true, id: `3EB0${String(++n).padStart(8, '0')}` }, status: 1 };
      sent.push({ jid, content, opts, msg,
                  fileExisted: content.document ? true : undefined });
      // WhatsApp's server acks shortly after
      if (autoAck && !content.delete) setImmediate(() => client.handleUpdates([{ key: msg.key, update: { status: 2 } }]));
      return msg;
    },
    groupFetchAllParticipating: async () => ({ [GROUP]: { id: GROUP, subject: 'Facilities' } }),
  };
  client = createBaileysClient({ getSocket: () => sock, log: quiet });
  const renders = [];
  const workflow = createPermitWorkflow({
    client, db, outDir, log: quiet,
    getSettings: () => settings,
    renderPdf: async html => { renders.push(html); return Buffer.from('%PDF-1.4 wf'); },
  });

  // Incoming messages arrive as raw Baileys messages, exactly as connection.js passes them on
  const receive = raw => workflow.handleMessage(client.wrapIncoming(raw));
  const clientSays = text => receive({ key: { remoteJid: CLIENT, fromMe: false, id: `IN${++n}` }, message: { conversation: text } });
  const adminSays = (text, quotedKeyId) => receive({
    key: { remoteJid: GROUP, fromMe: false, id: `IN${++n}`, participant: SITI_LID, participantPn: SITI_PN },
    message: { extendedTextMessage: { text, ...(quotedKeyId ? { contextInfo: { stanzaId: quotedKeyId } } : {}) } },
  });
  const toClient = () => sent.filter(s => s.jid === CLIENT && !s.content.delete);
  const toGroup = () => sent.filter(s => s.jid === GROUP && !s.content.delete);
  const deletes = () => sent.filter(s => s.content.delete);
  const dumpDb = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map(t => JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all())).join('\n');
  const ack = s => client.handleUpdates([{ key: s.msg.key, update: { status: 2 } }]);
  return { db, workflow, settings, outDir, sent, renders, toClient, toGroup, deletes, clientSays, adminSays, dumpDb, ack };
}

const PERMIT = 'PERMIT\nName: Ahmad Faiz\nCar Reg: WXY 1234\nStart: 01/12/2099\nEnd: 31/12/2099\nJustification: Night shift duty';
const textOf = s => s.content.text ?? s.content.caption;

test('approve via quote-reply from a @lid approver → PDF document to client → purge deletes group summary', async () => {
  const w = world();
  assert.equal(await w.clientSays(PERMIT), true);
  assert.match(textOf(w.toClient()[0]), /Request received: \*PP-0001\*/);
  const summary = w.toGroup()[0];
  assert.match(textOf(summary), /Parking permit request PP-0001/);

  // Approver quote-replies: Baileys gives the quoted message's key id as contextInfo.stanzaId
  assert.equal(await w.adminSays('APPROVE Bay B2 only', summary.msg.key.id), true);
  const reply = w.sent.find(s => s.jid === GROUP && textOf(s)?.includes('approved by'));
  assert.equal(textOf(reply), '✅ *PP-0001* approved by Siti Aminah.');
  assert.ok(reply.opts?.quoted, 'confirmation quotes the command');

  const letter = w.toClient()[1];
  assert.equal(letter.content.mimetype, 'application/pdf');
  assert.equal(letter.content.fileName, 'PP-0001.pdf');
  assert.match(letter.content.caption, /has been approved/);
  assert.ok(w.renders[0].includes('Bay B2 only'));
  assert.equal(w.workflow.approvals.getLog('PP-0001').client_notified_at !== null, true, 'notified only after the ack');

  const res = await w.workflow.runMaintenance();
  assert.equal(res.purged, 1);
  assert.deepEqual(w.deletes().map(d => d.content.delete), [{ remoteJid: GROUP, fromMe: true, id: summary.msg.key.id }]);
  assert.deepEqual(fs.readdirSync(w.outDir), []);
  for (const p of PII) assert.ok(!w.dumpDb().includes(p), `"${p}" still in db`);
});

test('typed REJECT works; reason reaches the client', async () => {
  const w = world();
  await w.clientSays(PERMIT);
  await w.adminSays('REJECT 1 Car park full');
  assert.match(textOf(w.toClient()[1]), /not approved[\s\S]*Reason: Car park full/);
  assert.equal(w.workflow.approvals.getLog('PP-0001').status, 'REJECTED');
});

test('notified only once WhatsApp acks the letter, not when the send call returns', async () => {
  const w = world({ autoAck: false });
  await w.clientSays(PERMIT);
  // deliver() runs inside the APPROVE handler and waits for the ack
  const handling = w.adminSays('APPROVE 1');
  await new Promise(r => setTimeout(r, 50));
  const letter = w.toClient().find(s => s.content.document);
  assert.ok(letter, 'letter sent');
  assert.equal(w.workflow.approvals.getLog('PP-0001').client_notified_at, null, 'not yet: no ack');
  w.ack(letter);
  await handling;
  assert.ok(w.workflow.approvals.getLog('PP-0001').client_notified_at, 'notified after the ack');
});

test('a non-approver is refused; other group chat and non-permit DMs are ignored', async () => {
  const w = world();
  w.settings.admin_approvers = [{ number: '60199999999', name: 'Someone Else' }];
  await w.clientSays(PERMIT);
  await w.adminSays('APPROVE 1');
  assert.ok(w.sent.some(s => textOf(s)?.includes('Only registered approvers')));
  assert.equal(w.workflow.approvals.getLog('PP-0001').status, 'PENDING');
  assert.equal(await w.adminSays('Approved, thanks all'), false);
  assert.equal(await w.clientSays('hello'), false);
});

test('onReady lists groups when none is set; handleMessage never throws', async () => {
  const w = world();
  w.settings.admin_group_id = '';
  const logged = [];
  const wf = createPermitWorkflow({
    client: { getChats: async () => [{ isGroup: true, name: 'Facilities', id: { _serialized: GROUP } }], on() {} },
    db: new Database(':memory:'), outDir: w.outDir, getSettings: () => w.settings, renderPdf: async () => Buffer.alloc(0),
    log: { log: m => logged.push(m), warn() {}, error() {} },
  });
  await wf.onReady();
  wf.stop();
  assert.ok(logged.some(l => l.includes(GROUP)));
  assert.equal(await wf.handleMessage(null), false);
});
