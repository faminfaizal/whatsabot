// approvalListener.js — admins APPROVE / REJECT permit requests in the admin WhatsApp group
//
// Usage (whatsapp.js):
//   const listener = require('./approvalListener').createApprovalListener({
//     approvals,
//     getGroupId:   () => settings.admin_group_id,
//     getApprovers: () => settings.admin_approvers,   // [{ "number": "60123456789", "name": "Siti Aminah" }]
//     onApproved:   ref => issueLetter(ref),          // task 5/6
//     onRejected:   ref => notifyRejected(ref),       // task 6
//   });
//   client.on('message', async msg => {
//     if (await intake.handle(msg)) return;
//     if (await listener.handle(msg)) return;
//     /* existing handlers */
//   });
//
// Commands (case-insensitive, WhatsApp bold ok):
//   reply to the request message:  APPROVE [remark]   |  REJECT reason
//   or type the number:            APPROVE 0042 [remark]  |  REJECT 0042 reason
'use strict';

const MAX_REMARK = 300;
const MAX_REASON = 500;

const COMMAND = /^\s*[*_~]*\s*(approve|reject)[*_~]*(?=\s|$)([\s\S]*)$/i;

// "60123456789@c.us" / "60123456789:12@c.us" / "1234567890@lid" → { digits, kind }
function parseWid(wid) {
  const m = String(wid || '').match(/^(\d+)(?::\d+)?@(c\.us|s\.whatsapp\.net|lid)$/);
  return m ? { digits: m[1], kind: m[2] === 'lid' ? 'lid' : 'phone' } : null;
}

// "012-345 6789" → "60123456789" (local Malaysian numbers get the 60 prefix)
function normalizeNumber(n) {
  const d = String(n || '').replace(/\D/g, '');
  return d.startsWith('0') ? `6${d}` : d;
}

const lidDigits = l => String(l || '').replace(/@lid$/, '').replace(/\D/g, '');

const MSG = {
  notApprover: 'Only registered approvers can approve or reject permit requests.',
  usage: 'Which request? Reply to the request message, or type *APPROVE 0042* / *REJECT 0042 reason*.',
  conflict: (quoted, typed) => `You replied to *${quoted}* but typed *${typed}*. Please send it again with just one request.`,
  needReason: ref => `Please include a reason: *REJECT ${ref.replace(/^PP-/, '')} reason*`,
  tooLong: (what, max) => `The ${what} is too long (max ${max} characters).`,
  notFound: ref => `*${ref}* was not found.`,
  expired: ref => `*${ref}* has expired. The applicant can submit a new request.`,
  already: (ref, status, who) => `*${ref}* was already ${status.toLowerCase()}${who ? ` by ${who}` : ''}.`,
  approved: (ref, who) => `✅ *${ref}* approved by ${who}.`,
  rejected: (ref, who) => `❌ *${ref}* rejected by ${who}.`,
};

function createApprovalListener({ approvals, getGroupId, getApprovers,
                                  onApproved = async () => {}, onRejected = async () => {}, log = console }) {

  // Returns the approver's name, or null. Tries the author ID first, then the contact's phone number.
  async function findApprover(msg) {
    const list = (getApprovers() || []).map(a => ({
      name: String(a.name || '').trim(), number: normalizeNumber(a.number), lid: lidDigits(a.lid),
    })).filter(a => a.name && (a.number || a.lid));

    const author = parseWid(msg.author);
    const byAuthor = author && list.find(a => (author.kind === 'phone' ? a.number : a.lid) === author.digits);
    if (byAuthor) return byAuthor.name;

    if (typeof msg.getContact === 'function') {
      try {
        const c = await msg.getContact();
        const num = normalizeNumber(c && c.number);
        const byContact = num && list.find(a => a.number === num);
        if (byContact) return byContact.name;
      } catch { /* fall through */ }
    }
    return null;
  }

  async function quotedRef(msg) {
    if (!msg.hasQuotedMsg || typeof msg.getQuotedMessage !== 'function') return null;
    try {
      const q = await msg.getQuotedMessage();
      if (!q || !q.id) return null;
      return approvals.findRefByGroupMsg(q.id._serialized) || approvals.findRefByGroupMsgKey(q.id.id);
    } catch { return null; }
  }

  // Returns true if the message was an approval command in the admin group (handled), else false.
  async function handle(msg) {
    const gid = String(getGroupId() || '').trim();
    if (!gid || !msg || msg.fromMe || msg.from !== gid) return false;
    const cmd = String(msg.body || '').match(COMMAND);
    if (!cmd) return false;

    const action = cmd[1].toUpperCase();
    const rest = cmd[2].trim();
    const reply = text => msg.reply(text);

    const approver = await findApprover(msg);
    if (!approver) {
      log.warn(`[permit] ${action} from non-approver ${msg.author || '(unknown)'}; add this ID to admin_approvers if it is an approver`);
      await reply(MSG.notApprover);
      return true;
    }

    // Work out which request, and what text is the remark / reason
    const firstTok = rest.split(/\s+/)[0] || '';
    const typedRef = approvals.normalizeRef(firstTok.replace(/[,.:;]+$/, ''));
    const qRef = await quotedRef(msg);
    let ref, text;
    if (qRef) {
      // A different number that is a real request is ambiguous; otherwise it's just part of the remark ("2 cars max")
      if (typedRef && typedRef !== qRef && approvals.getLog(typedRef)) { await reply(MSG.conflict(qRef, typedRef)); return true; }
      ref = qRef;
      text = typedRef === qRef ? rest.slice(firstTok.length) : rest;
    } else {
      if (!typedRef) { await reply(MSG.usage); return true; }
      ref = typedRef;
      text = rest.slice(firstTok.length);
    }
    text = text.replace(/^\s*[-–—:,]\s*/, '').trim();

    if (action === 'REJECT' && text.length < 3) { await reply(MSG.needReason(ref)); return true; }
    const max = action === 'APPROVE' ? MAX_REMARK : MAX_REASON;
    if (text.length > max) { await reply(MSG.tooLong(action === 'APPROVE' ? 'remark' : 'reason', max)); return true; }

    const result = action === 'APPROVE'
      ? approvals.approve(ref, approver, text || null)
      : approvals.reject(ref, approver, text);

    if (!result.ok) {
      const cur = result.current;
      if (!cur) await reply(MSG.notFound(ref));
      else if (cur.status === 'PENDING' || cur.status === 'EXPIRED') await reply(MSG.expired(ref));
      else await reply(MSG.already(ref, cur.status, cur.approver_name));
      return true;
    }

    await reply(action === 'APPROVE' ? MSG.approved(ref, approver) : MSG.rejected(ref, approver));
    try { await (action === 'APPROVE' ? onApproved : onRejected)(ref); }
    catch (e) { log.error(`[permit] after ${action} of ${ref}:`, e.message); }
    return true;
  }

  return { handle };
}

module.exports = { createApprovalListener, parseWid, normalizeNumber };
