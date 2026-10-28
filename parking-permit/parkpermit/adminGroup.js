// adminGroup.js — posts each new permit request to the admin WhatsApp group
//
// Usage (whatsapp.js):
//   const { createAdminGroup, logGroups } = require('./adminGroup');
//   const adminGroup = createAdminGroup({
//     approvals,
//     send: (chatId, text) => client.sendMessage(chatId, text),   // must resolve to the sent Message
//     getGroupId: () => settings.admin_group_id,                  // read the CURRENT setting each call
//   });
//   // intake: onCreated: ref => adminGroup.postRequest(ref)
//   client.on('ready', async () => {
//     if (!settings.admin_group_id) await logGroups(client);      // prints group names + IDs to the log
//     await adminGroup.postUnposted();
//   });
//   setInterval(() => adminGroup.postUnposted().catch(e => console.error('[permit]', e.message)), 5 * 60e3);
'use strict';

const { formatCarReg, formatDate } = require('./intake');

const shortNo = ref => ref.replace(/^PP-/, '');

// ISO UTC → "27 Oct 2026, 11:13 AM" in Malaysia time
function formatDateTimeMYT(iso) {
  const d = new Date(Date.parse(iso) + 8 * 3600e3);
  const h24 = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${formatDate(d.toISOString().slice(0, 10))}, ${h24 % 12 || 12}:${mm} ${h24 >= 12 ? 'PM' : 'AM'}`;
}

function summaryText(r) {
  const days = Math.round((Date.parse(r.permit_end) - Date.parse(r.permit_start)) / 864e5) + 1;
  const n = shortNo(r.ref_no);
  return [
    `🅿️ *Parking permit request ${r.ref_no}*`,
    '',
    `Name: ${r.applicant_name}`,
    `Car Reg: ${formatCarReg(r.car_reg)}`,
    `Period: ${formatDate(r.permit_start)} – ${formatDate(r.permit_end)} (${days} day${days === 1 ? '' : 's'})`,
    `Justification: ${r.justification}`,
    '',
    `⏳ Expires ${formatDateTimeMYT(r.expires_at)}`,
    '',
    'Reply to this message with:',
    '*APPROVE* optional remark',
    '*REJECT* reason',
    `or type *APPROVE ${n}* / *REJECT ${n} reason*`,
  ].join('\n');
}

function createAdminGroup({ approvals, send, getGroupId, log = console }) {
  const inFlight = new Set();   // stops onCreated and the sweep posting the same request twice
  let warned = false;

  function groupId() {
    const id = String(getGroupId() || '').trim();
    if (id.endsWith('@g.us')) { warned = false; return id; }
    if (!warned) {
      log.warn(id
        ? `[permit] admin_group_id "${id}" is not a group ID (should end in @g.us); requests are queued`
        : '[permit] admin_group_id not set; requests are queued until it is');
      warned = true;
    }
    return null;
  }

  // Posts one request. Returns true if posted, false if skipped (no group, already posted, not pending).
  // Throws if sending fails; the request stays unposted and the next sweep retries it.
  async function postRequest(ref) {
    if (inFlight.has(ref)) return false;
    const gid = groupId();
    if (!gid) return false;
    const r = approvals.getRequest(ref);
    if (!r || r.status !== 'PENDING' || r.group_msg_id || r.expires_at <= new Date().toISOString()) return false;

    inFlight.add(ref);
    try {
      const msg = await send(gid, summaryText(r));
      const msgId = msg && msg.id && msg.id._serialized;
      if (!msgId) throw new Error('send returned no message id');
      approvals.setGroupMsgId(ref, msgId);
      return true;
    } finally {
      inFlight.delete(ref);
    }
  }

  // Posts every queued request, oldest first. Returns the number posted.
  async function postUnposted() {
    if (!groupId()) return 0;
    let posted = 0;
    for (const ref of approvals.listUnposted()) {
      try { if (await postRequest(ref)) posted++; }
      catch (e) { log.error(`[permit] posting ${ref} to admin group failed:`, e.message); }
    }
    return posted;
  }

  return { postRequest, postUnposted };
}

// One-off helper: logs every group the bot is in, so you can copy the admin group's ID.
async function logGroups(client, log = console) {
  const groups = (await client.getChats())
    .filter(c => c.isGroup)
    .map(c => ({ name: c.name, id: c.id._serialized }));
  log.log(`[permit] admin_group_id not set. Groups this bot is in (${groups.length}):`);
  for (const g of groups) log.log(`[permit]   ${g.name} → ${g.id}`);
  return groups;
}

module.exports = { createAdminGroup, logGroups, summaryText, formatDateTimeMYT };
