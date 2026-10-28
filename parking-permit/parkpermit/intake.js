// intake.js — client DMs "PERMIT ..." to the bot → validated parking permit request
//
// Usage (whatsapp.js):
//   const intake = require('./intake').createIntake({
//     approvals,                                   // require('./approvalDb')(db)
//     send: (chatId, text) => client.sendMessage(chatId, text),
//     getTimeoutHours: () => settings.approval_timeout_hours ?? 36,
//     onCreated: ref => postToAdminGroup(ref),     // task 3
//   });
//   client.on('message', async msg => { if (await intake.handle(msg)) return; /* existing handlers */ });
'use strict';

const { createLimiter } = require('./limiter');

const MAX_PERMIT_DAYS = 365;
const DEFAULT_MAX_PER_DAY = 5;          // permit requests one WhatsApp number may create per 24 h
const MAX_MESSAGES_PER_MINUTE = 10;     // PERMIT messages one number may send per minute before being ignored

const TEMPLATE = [
  'PERMIT',
  'Name: ',
  'Car Reg: ',
  'Start: DD/MM/YYYY',
  'End: DD/MM/YYYY',
  'Justification: ',
].join('\n');

// Accepted labels (case-insensitive, WhatsApp bold/italic markers ignored)
const LABELS = {
  name:          /^(name|nama)$/,
  carReg:        /^(car\s*reg(istration)?(\s*no)?|car\s*no|plate(\s*no)?|vehicle\s*no)$/,
  start:         /^(start(\s*date)?|date\s*start)$/,
  end:           /^(end(\s*date)?|date\s*end)$/,
  justification: /^(justification|reason|purpose)$/,
};

const stripMarks = s => s.replace(/^[\s*_~]+|[\s*_~]+$/g, '');

const firstLine = body => (String(body || '').split(/\r?\n/).find(l => l.trim()) || '');
const isPermitMessage = body => /^permit\b/i.test(stripMarks(firstLine(body)));

// Raw field strings keyed by field name; unknown "Label: x" lines continue the justification.
function parsePermit(body) {
  const lines = String(body || '').split(/\r?\n/);
  const start = lines.findIndex(l => l.trim()) + 1;
  const out = {};
  let last = null;
  for (const line of lines.slice(start)) {
    const m = line.match(/^\s*[*_~]*\s*([A-Za-z][A-Za-z .]*?)\s*[*_~]*\s*[:：]\s*(.*)$/);
    const label = m && m[1].toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
    const field = label && Object.keys(LABELS).find(k => LABELS[k].test(label));
    if (field) {
      out[field] = stripMarks(m[2]);
      last = field;
    } else if (last === 'justification' && line.trim()) {
      out.justification = `${out.justification}\n${stripMarks(line)}`.trim();
    }
  }
  return out;
}

// "1/11/2026", "01-11-2026", "01.11.2026" → "2026-11-01"; null if not a real date
function parseDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

// "wxy-1234" → "WXY1234"; null if invalid
function normalizeCarReg(s) {
  const v = String(s || '').toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z0-9]{2,12}$/.test(v) && /[A-Z]/.test(v) && /\d/.test(v) ? v : null;
}

// "WXY1234A" → "WXY 1234 A" (display only)
const formatCarReg = v => v.replace(/([A-Z])(?=\d)|(\d)(?=[A-Z])/g, '$1$2 ');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const formatDate = iso => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

const todayMYT = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

function validatePermit(raw, { today = todayMYT(), maxDays = MAX_PERMIT_DAYS } = {}) {
  const errors = [];
  const data = {};

  const name = (raw.name || '').replace(/\s+/g, ' ').trim();
  if (!name) errors.push('Name is missing');
  else if (name.length < 2 || name.length > 100) errors.push('Name must be 2–100 characters');
  else data.name = name;

  if (!raw.carReg) errors.push('Car Reg is missing');
  else if (!(data.carReg = normalizeCarReg(raw.carReg))) errors.push('Car Reg should be letters and numbers only, e.g. WXY 1234');

  for (const [key, label] of [['start', 'Start'], ['end', 'End']]) {
    if (!raw[key]) errors.push(`${label} date is missing`);
    else if (!(data[key] = parseDate(raw[key]))) errors.push(`${label} date should be DD/MM/YYYY, e.g. 01/11/2026`);
  }
  if (data.start && data.start < today) errors.push('Start date can’t be in the past');
  if (data.start && data.end) {
    if (data.end < data.start) errors.push('End date must be on or after the start date');
    else if (daysBetween(data.start, data.end) + 1 > maxDays) errors.push(`Permit period can’t be longer than ${maxDays} days`);
  }

  const just = (raw.justification || '').trim();
  if (!just) errors.push('Justification is missing');
  else if (just.length < 5) errors.push('Justification is too short');
  else if (just.length > 500) errors.push('Justification must be 500 characters or fewer');
  else data.justification = just;

  return errors.length ? { ok: false, errors } : { ok: true, data };
}

const MSG = {
  help: 'To apply for a building parking permit, copy the next message, fill it in and send it back.',
  errors: errs => `❌ Your permit request couldn’t be submitted:\n${errs.map(e => `• ${e}`).join('\n')}\n\nPlease copy the next message, fix the details and send it again.`,
  duplicate: (ref, car) => `You already have a pending request *${ref}* for ${car}. You’ll receive the letter here once it’s reviewed.`,
  dailyLimit: max => `You’ve reached today’s limit of ${max} permit request${max === 1 ? '' : 's'}. Please try again tomorrow, or contact building management.`,
  failed: 'Sorry, we couldn’t record your request right now. Please try again later.',
  ack: (ref, d, hours) => [
    `✅ Request received: *${ref}*`,
    '',
    `Name: ${d.name}`,
    `Car Reg: ${formatCarReg(d.carReg)}`,
    `Period: ${formatDate(d.start)} – ${formatDate(d.end)}`,
    '',
    `You’ll receive the decision here within ${hours} hours.`,
  ].join('\n'),
};

function createIntake({ approvals, send, getTimeoutHours, onCreated = async () => {},
                        getMaxPerDay = () => DEFAULT_MAX_PER_DAY, now = Date.now,
                        today = todayMYT, maxDays = MAX_PERMIT_DAYS, log = console }) {
  const perMinute = createLimiter({ windowMs: 60_000, now });
  const perDay = createLimiter({ windowMs: 24 * 3600_000, now });

  // Returns true if the message was a permit request (handled), false to pass it on.
  async function handle(msg) {
    const from = msg && msg.from;
    if (!from || msg.fromMe || from.endsWith('@g.us') || from === 'status@broadcast') return false;
    if (!isPermitMessage(msg.body)) return false;

    // Flood guard: past the per-minute allowance the number is ignored (no reply, so the bot can't be
    // made to send a flood of messages back)
    if (perMinute.count(from) >= MAX_MESSAGES_PER_MINUTE) return true;
    perMinute.add(from);

    const raw = parsePermit(msg.body);
    if (!Object.keys(raw).length) {
      await send(from, MSG.help);
      await send(from, TEMPLATE);
      return true;
    }

    const v = validatePermit(raw, { today: today(), maxDays });
    if (!v.ok) {
      await send(from, MSG.errors(v.errors));
      await send(from, TEMPLATE);
      return true;
    }

    const existing = approvals.findPendingByClient(from, v.data.carReg);
    if (existing) {
      await send(from, MSG.duplicate(existing, formatCarReg(v.data.carReg)));
      return true;
    }

    const maxPerDay = Number(getMaxPerDay());
    if (maxPerDay > 0 && perDay.count(from) >= maxPerDay) {
      await send(from, MSG.dailyLimit(maxPerDay));
      return true;
    }

    const hours = Number(getTimeoutHours());
    let ref;
    try {
      ref = approvals.createRequest({ clientJid: from, ...v.data }, hours);
    } catch (e) {
      log.error('[permit] createRequest failed:', e.message);   // no PII in logs
      await send(from, MSG.failed);
      return true;
    }

    perDay.add(from);
    await send(from, MSG.ack(ref, v.data, hours));
    try { await onCreated(ref); }
    catch (e) { log.error(`[permit] onCreated failed for ${ref}:`, e.message); }
    return true;
  }

  return { handle };
}

module.exports = {
  createIntake, parsePermit, validatePermit, isPermitMessage,
  parseDate, normalizeCarReg, formatCarReg, formatDate, TEMPLATE,
};
