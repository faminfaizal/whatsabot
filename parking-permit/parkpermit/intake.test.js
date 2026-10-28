// Run: node --test intake.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const createApprovalDb = require('./approvalDb');
const {
  createIntake, parsePermit, validatePermit, isPermitMessage,
  parseDate, normalizeCarReg, formatCarReg, TEMPLATE,
} = require('./intake');

const TODAY = '2026-10-25';
const CLIENT = '60123456789@c.us';
const good = [
  'PERMIT',
  'Name: Ahmad Faiz',
  'Car Reg: wxy-1234',
  'Start: 1/11/2026',
  'End: 30/11/2026',
  'Justification: Night shift duty',
].join('\n');

function harness(opts = {}) {
  const approvals = createApprovalDb(new Database(':memory:'));
  const sent = [], created = [], logs = [];
  const intake = createIntake({
    approvals,
    send: async (to, text) => { sent.push({ to, text }); },
    getTimeoutHours: () => 36,
    onCreated: async ref => { created.push(ref); if (opts.failOnCreated) throw new Error('group down'); },
    today: () => TODAY,
    ...(opts.getMaxPerDay ? { getMaxPerDay: opts.getMaxPerDay } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    log: { error: (...a) => logs.push(a.join(' ')) },
  });
  return { approvals, intake, sent, created, logs };
}
const dm = (body, extra = {}) => ({ from: CLIENT, body, fromMe: false, ...extra });

// ── parsing ──────────────────────────────────────────────
test('detects PERMIT keyword on first non-empty line, any case, bold ok', () => {
  for (const b of ['PERMIT', 'permit\nName: x', '\n\n *Permit* \nName: x', 'Permit please']) assert.ok(isPermitMessage(b), b);
  for (const b of ['hello', 'Name: x\nPERMIT', 'permits', '', null]) assert.ok(!isPermitMessage(b), String(b));
});

test('parses labels flexibly: case, bold, alt labels, CRLF, full-width colon', () => {
  const raw = parsePermit('PERMIT\r\n*Name:* Ahmad\r\nCAR REG NO.: WXY 1234\r\nStart Date：01/11/2026\r\n_end date_: 30/11/2026\r\nReason: Night shift');
  assert.deepEqual(raw, { name: 'Ahmad', carReg: 'WXY 1234', start: '01/11/2026', end: '30/11/2026', justification: 'Night shift' });
});

test('multi-line justification, including lines that look like labels', () => {
  const raw = parsePermit('PERMIT\nName: A\nJustification: Night shift\nweekdays only\nNote: carpool with team\n\nCar Reg: W1');
  assert.equal(raw.justification, 'Night shift\nweekdays only\nNote: carpool with team');
  assert.equal(raw.carReg, 'W1', 'known label after justification still parsed');
});

test('dates: accepts d/m/yyyy variants, rejects impossible dates', () => {
  assert.equal(parseDate('1/11/2026'), '2026-11-01');
  assert.equal(parseDate('01-11-2026'), '2026-11-01');
  assert.equal(parseDate('01.11.2026'), '2026-11-01');
  for (const s of ['31/02/2026', '00/01/2026', '01/13/2026', '2026-11-01', '1/11/26', '']) assert.equal(parseDate(s), null, s);
});

test('car reg normalises and validates', () => {
  assert.equal(normalizeCarReg('wxy-1234'), 'WXY1234');
  assert.equal(normalizeCarReg(' W 1 '), 'W1');
  assert.equal(normalizeCarReg('Putrajaya 1'), 'PUTRAJAYA1');
  for (const s of ['ABC', '1234', 'WXY 12#4', 'A'.repeat(12) + '1']) assert.equal(normalizeCarReg(s), null, s);
  assert.equal(formatCarReg('WXY1234A'), 'WXY 1234 A');
});

// ── validation ───────────────────────────────────────────
const raw = o => ({ name: 'Ahmad', carReg: 'WXY1234', start: '01/11/2026', end: '30/11/2026', justification: 'Night shift', ...o });

test('valid request', () => {
  assert.deepEqual(validatePermit(raw(), { today: TODAY }), {
    ok: true, data: { name: 'Ahmad', carReg: 'WXY1234', start: '2026-11-01', end: '2026-11-30', justification: 'Night shift' },
  });
});

test('start today is allowed, yesterday is not', () => {
  assert.ok(validatePermit(raw({ start: '25/10/2026' }), { today: TODAY }).ok);
  assert.deepEqual(validatePermit(raw({ start: '24/10/2026' }), { today: TODAY }).errors, ['Start date can’t be in the past']);
});

test('end before start and over-long period', () => {
  assert.deepEqual(validatePermit(raw({ end: '31/10/2026' }), { today: TODAY }).errors, ['End date must be on or after the start date']);
  assert.ok(validatePermit(raw({ end: '01/11/2026' }), { today: TODAY }).ok, 'single day ok');
  assert.ok(validatePermit(raw({ start: '01/11/2026', end: '31/10/2027' }), { today: TODAY }).ok, '365 days ok');
  assert.deepEqual(validatePermit(raw({ start: '01/11/2026', end: '01/11/2027' }), { today: TODAY }).errors,
    ['Permit period can’t be longer than 365 days']);
});

test('reports every problem at once', () => {
  const v = validatePermit({ carReg: '###', start: '31/02/2026', justification: 'x' }, { today: TODAY });
  assert.deepEqual(v.errors, [
    'Name is missing',
    'Car Reg should be letters and numbers only, e.g. WXY 1234',
    'Start date should be DD/MM/YYYY, e.g. 01/11/2026',
    'End date is missing',
    'Justification is too short',
  ]);
});

// ── handler ──────────────────────────────────────────────
test('ignores groups, own messages, status and non-permit DMs', async () => {
  const h = harness();
  assert.equal(await h.intake.handle(dm(good, { from: '1203@g.us' })), false);
  assert.equal(await h.intake.handle(dm(good, { fromMe: true })), false);
  assert.equal(await h.intake.handle(dm(good, { from: 'status@broadcast' })), false);
  assert.equal(await h.intake.handle(dm('hello')), false);
  assert.equal(h.sent.length, 0);
});

test('bare PERMIT replies with help, then the template as a separate message', async () => {
  const h = harness();
  assert.equal(await h.intake.handle(dm('permit')), true);
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].text, TEMPLATE);
  assert.equal(h.created.length, 0);
});

test('invalid request lists errors + template, creates nothing', async () => {
  const h = harness();
  await h.intake.handle(dm('PERMIT\nName: Ahmad\nCar Reg: WXY1234'));
  assert.match(h.sent[0].text, /• Start date is missing/);
  assert.match(h.sent[0].text, /• Justification is missing/);
  assert.equal(h.sent[1].text, TEMPLATE);
  assert.equal(h.approvals.getLog('PP-0001'), null);
});

test('valid request: stored, client gets ref, onCreated fires', async () => {
  const h = harness();
  assert.equal(await h.intake.handle(dm(good)), true);
  const r = h.approvals.getRequest('PP-0001');
  assert.equal(r.client_jid, CLIENT);
  assert.equal(r.car_reg, 'WXY1234');
  assert.equal(r.permit_start, '2026-11-01');
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /\*PP-0001\*/);
  assert.match(h.sent[0].text, /Car Reg: WXY 1234/);
  assert.match(h.sent[0].text, /1 Nov 2026 – 30 Nov 2026/);
  assert.match(h.sent[0].text, /within 36 hours/);
  assert.deepEqual(h.created, ['PP-0001']);
});

test('duplicate pending request returns existing ref, no new row', async () => {
  const h = harness();
  await h.intake.handle(dm(good));
  await h.intake.handle(dm(good));
  assert.match(h.sent[1].text, /already have a pending request \*PP-0001\*/);
  assert.equal(h.approvals.getLog('PP-0002'), null);
  assert.deepEqual(h.created, ['PP-0001']);
});

test('onCreated failure is logged without PII and does not affect the client', async () => {
  const h = harness({ failOnCreated: true });
  assert.equal(await h.intake.handle(dm(good)), true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /PP-0001/);
  for (const pii of ['Ahmad', 'WXY', '60123456789', 'Night shift']) assert.ok(!h.logs[0].includes(pii), pii);
});

test('db failure tells client to retry and logs no PII', async () => {
  const h = harness();
  h.approvals.createRequest = () => { throw new Error('SQLITE_BUSY'); };
  await h.intake.handle(dm(good));
  assert.match(h.sent[0].text, /couldn’t record your request/);
  assert.ok(!h.logs[0].includes('Ahmad'));
});

// ── spam guard ───────────────────────────────────────────
const variant = n => good.replace('wxy-1234', `ab${n}-1234`);   // a different car each time, so the pending-duplicate check doesn't fire

test('daily cap: the Nth+1 request in 24 h is refused with a message, then allowed again after 24 h', async () => {
  let t = Date.parse('2026-10-25T00:00:00Z');
  const h = harness({ getMaxPerDay: () => 3, now: () => t });
  for (let i = 1; i <= 3; i++) { await h.intake.handle(dm(variant(i))); t += 60_000; }
  assert.equal(h.created.length, 3);
  await h.intake.handle(dm(variant(4)));
  assert.equal(h.created.length, 3, 'fourth not created');
  assert.match(h.sent.at(-1).text, /today’s limit of 3 permit requests/);
  t += 24 * 3600_000;
  await h.intake.handle(dm(variant(5)));
  assert.equal(h.created.length, 4, 'allowed again after the window');
});

test('daily cap counts only created requests: duplicates and invalid messages do not use it up', async () => {
  const h = harness({ getMaxPerDay: () => 2 });
  await h.intake.handle(dm(good));
  await h.intake.handle(dm(good));                                  // duplicate of the pending one
  await h.intake.handle(dm('PERMIT\nName: x'));                     // invalid
  await h.intake.handle(dm(variant(2)));
  assert.equal(h.created.length, 2);
});

test('flood guard: after 10 PERMIT messages in a minute the number is ignored silently', async () => {
  const h = harness({ getMaxPerDay: () => 100 });
  for (let i = 0; i < 10; i++) await h.intake.handle(dm('PERMIT'));
  const before = h.sent.length;
  assert.equal(await h.intake.handle(dm('PERMIT')), true, 'still reported as handled');
  assert.equal(h.sent.length, before, 'no reply sent');
  // other numbers are unaffected
  await h.intake.handle({ from: '60199999999@c.us', fromMe: false, body: 'PERMIT' });
  assert.ok(h.sent.length > before);
});
