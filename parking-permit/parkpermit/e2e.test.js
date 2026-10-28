// Run: node --test e2e.test.js
// Whole workflow with every real module, wired as in whatsapp.js, against a fake WhatsApp client.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const createApprovalDb = require('./approvalDb');
const { createIntake } = require('./intake');
const { createAdminGroup } = require('./adminGroup');
const { createApprovalListener } = require('./approvalListener');
const { createLetterService } = require('./letter');
const { createDelivery } = require('./delivery');
const { createMaintenance } = require('./maintenance');

const GROUP = '120363041234567890@g.us';
const CLIENT = '60111111111@c.us';
const SITI = '60123456789@c.us';
const PII = ['Ahmad Faiz', 'WXY1234', 'WXY 1234', '60111111111', 'Night shift duty', 'Bay B2 only', 'Car park full'];

function world() {
  const db = new Database(':memory:');
  const approvals = createApprovalDb(db);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const settings = {
    admin_group_id: GROUP,
    approval_timeout_hours: 36,
    admin_approvers: [{ number: '012-345 6789', name: 'Siti Aminah' }],
    letterhead: { org_name: 'Menara Contoh' },
  };
  const quiet = { log() {}, warn() {}, error() {} };

  // Fake whatsapp-web.js client
  const sent = [], deletedMsgs = [];
  let n = 0;
  const client = {
    sendMessage: async (to, content, opts = {}) => {
      const key = `3EB0${String(++n).padStart(12, '0')}`;
      sent.push({ to, text: typeof content === 'string' ? content : opts.caption, file: content.file,
                  fileExisted: content.file ? fs.existsSync(content.file) : undefined });
      return { id: { _serialized: `true_${to}_${key}`, id: key }, ack: 1 };
    },
    getMessageById: async id => ({ delete: async everyone => { if (everyone) deletedMsgs.push(id); } }),
  };
  // Stands in for Chrome; letter.test.js covers the real render
  const renderPdf = async () => Buffer.from('%PDF-1.4 e2e');

  // ── wiring of the modules (permitWorkflow.test.js covers the real wiring through Baileys) ──
  const letters = createLetterService({ approvals, getLetterhead: () => settings.letterhead, outDir,
                                        renderPdf, log: quiet });
  const delivery = createDelivery({
    approvals, letters,
    sendText: (to, text) => client.sendMessage(to, text),
    sendFile: (to, file, caption) => client.sendMessage(to, { file }, { caption }),
    waitForAck: async m => { if (!(m.ack >= 1)) throw new Error('no ack'); },
    getGroupId: () => settings.admin_group_id, log: quiet,
  });
  const adminGroup = createAdminGroup({ approvals, send: (to, t) => client.sendMessage(to, t),
                                        getGroupId: () => settings.admin_group_id, log: quiet });
  const intake = createIntake({ approvals, send: (to, t) => client.sendMessage(to, t),
                                getTimeoutHours: () => settings.approval_timeout_hours,
                                onCreated: ref => adminGroup.postRequest(ref), today: () => '2026-10-25', log: quiet });
  const listener = createApprovalListener({ approvals, getGroupId: () => settings.admin_group_id,
                                            getApprovers: () => settings.admin_approvers,
                                            onApproved: ref => delivery.deliver(ref), onRejected: ref => delivery.deliver(ref), log: quiet });
  const maintenance = createMaintenance({ approvals, adminGroup, delivery, outDir, log: quiet,
    deleteGroupMessage: async id => { const m = await client.getMessageById(id); if (m) await m.delete(true); } });

  const onMessage = async msg => (await intake.handle(msg)) || (await listener.handle(msg));

  const clientSays = body => onMessage({ from: CLIENT, fromMe: false, body });
  const adminSays = (body, quotedMsgId) => {
    const replies = [];
    const msg = {
      from: GROUP, author: SITI, fromMe: false, body,
      hasQuotedMsg: !!quotedMsgId,
      getQuotedMessage: async () => ({ id: { _serialized: quotedMsgId, id: quotedMsgId.split('_').pop() } }),
      getContact: async () => ({}),
      reply: async t => { replies.push(t); },
    };
    return onMessage(msg).then(() => replies);
  };

  // Everything the db holds, every table, as one string
  const dumpDb = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .map(t => JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all())).join('\n');

  const toClient = () => sent.filter(s => s.to === CLIENT);
  const toGroup = () => sent.filter(s => s.to === GROUP);
  return { db, approvals, settings, outDir, sent, deletedMsgs, toClient, toGroup, clientSays, adminSays, maintenance, dumpDb };
}

const PERMIT = 'PERMIT\nName: Ahmad Faiz\nCar Reg: WXY 1234\nStart: 01/11/2026\nEnd: 30/11/2026\nJustification: Night shift duty';

test('approve path: DM → group → quote-reply APPROVE → PDF to client → purge leaves no PII', async () => {
  const w = world();

  await w.clientSays(PERMIT);
  assert.match(w.toClient()[0].text, /Request received: \*PP-0001\*/);
  const summary = w.toGroup()[0];
  assert.match(summary.text, /Parking permit request PP-0001/);
  const summaryId = w.approvals.getRequest('PP-0001').group_msg_id;

  const replies = await w.adminSays('APPROVE Bay B2 only', summaryId);
  assert.deepEqual(replies, ['✅ *PP-0001* approved by Siti Aminah.']);

  const letter = w.toClient()[1];
  assert.equal(letter.file, path.join(w.outDir, 'PP-0001.pdf'));
  assert.equal(letter.fileExisted, true);
  assert.match(letter.text, /has been approved/);
  assert.match(w.toGroup().at(-1).text, /approval letter sent/);

  const res = await w.maintenance.runOnce();
  assert.equal(res.purged, 1);
  assert.deepEqual(w.deletedMsgs, [summaryId], 'group summary deleted for everyone');
  assert.deepEqual(fs.readdirSync(w.outDir), [], 'letter removed from disk');

  const dump = w.dumpDb();
  for (const p of PII) assert.ok(!dump.includes(p), `"${p}" still in db`);
  const logRow = w.approvals.getLog('PP-0001');
  assert.equal(logRow.status, 'APPROVED');
  assert.equal(logRow.approver_name, 'Siti Aminah');
  assert.ok(logRow.client_notified_at && logRow.purged_at);

  // Admin group's remaining bot messages contain no applicant details
  for (const g of w.toGroup().slice(1)) for (const p of PII) assert.ok(!g.text.includes(p), `"${p}" in group: ${g.text}`);
});

test('reject path: typed REJECT → reason to client → purge', async () => {
  const w = world();
  await w.clientSays(PERMIT);
  const replies = await w.adminSays('REJECT 1 Car park full this month');
  assert.deepEqual(replies, ['❌ *PP-0001* rejected by Siti Aminah.']);
  assert.match(w.toClient()[1].text, /not approved[\s\S]*Reason: Car park full this month/);
  assert.equal((await w.maintenance.runOnce()).purged, 1);
  const dump = w.dumpDb();
  for (const p of PII) assert.ok(!dump.includes(p), p);
  assert.equal(w.approvals.getLog('PP-0001').status, 'REJECTED');
});

test('expiry path: one maintenance run expires, notifies client and group, and purges', async () => {
  const w = world();
  await w.clientSays(PERMIT);
  w.db.prepare('UPDATE approval_log SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
  const res = await w.maintenance.runOnce();
  assert.deepEqual(res, { expired: 1, posted: 0, delivered: 1, purged: 1, strayFiles: 0 });
  assert.match(w.toClient()[1].text, /has expired/);
  assert.match(w.toGroup().at(-1).text, /expired with no decision/);
  const late = await w.adminSays('APPROVE 1');
  assert.match(late[0], /has expired|not found/);
  for (const p of PII) assert.ok(!w.dumpDb().includes(p), p);
});

test('no group configured at first: request waits, then flows once the group ID is set', async () => {
  const w = world();
  w.settings.admin_group_id = '';
  await w.clientSays(PERMIT);
  assert.equal(w.toGroup().length, 0);
  w.settings.admin_group_id = GROUP;
  assert.equal((await w.maintenance.runOnce()).posted, 1);
  const id = w.approvals.getRequest('PP-0001').group_msg_id;
  await w.adminSays('APPROVE', id);
  assert.equal((await w.maintenance.runOnce()).purged, 1);
});
