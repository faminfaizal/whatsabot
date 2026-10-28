// delivery.js — tells the applicant the outcome (approval letter PDF, rejection, or expiry),
// waits until WhatsApp confirms the send, then marks the request as notified.
//
// Usage (whatsapp.js):
//   const { MessageMedia } = require('whatsapp-web.js');
//   const { createDelivery, createAckWaiter } = require('./delivery');
//   const delivery = createDelivery({
//     approvals, letters,
//     sendText: (to, text) => client.sendMessage(to, text),
//     sendFile: (to, filePath, caption) => client.sendMessage(to, MessageMedia.fromFilePath(filePath),
//                                                              { caption, sendMediaAsDocument: true }),
//     waitForAck: createAckWaiter(client),
//     getGroupId: () => settings.admin_group_id,
//   });
//   // listener: onApproved: ref => delivery.deliver(ref), onRejected: ref => delivery.deliver(ref)
//   // every 5 min + on ready: delivery.deliverOutstanding()
'use strict';

const { formatDate } = require('./intake');

const ACK_TIMEOUT_MS = 60_000;
const WARN_AFTER_FAILURES = 3;

const period = r => (r.permit_start === r.permit_end
  ? formatDate(r.permit_start)
  : `${formatDate(r.permit_start)} – ${formatDate(r.permit_end)}`);

const CLIENT = {
  approved: r => [
    `✅ Your building parking permit *${r.ref_no}* has been approved.`,
    `Valid: ${period(r)}`,
    '',
    'Your approval letter is attached. Please keep it and show it when requested.',
  ].join('\n'),
  rejected: r => [
    `❌ Your parking permit request *${r.ref_no}* was not approved.`,
    '',
    `Reason: ${r.reject_reason}`,
    '',
    'You may submit a new request by sending *PERMIT*.',
  ].join('\n'),
  expired: r => [
    `⌛ Your parking permit request *${r.ref_no}* was not reviewed in time and has expired.`,
    '',
    'Please send *PERMIT* to submit a new request.',
  ].join('\n'),
};

// Group notes carry no applicant details
const GROUP = {
  APPROVED: ref => `📨 *${ref}*: approval letter sent to the applicant.`,
  REJECTED: ref => `📨 *${ref}*: applicant notified of the rejection.`,
  EXPIRED: ref => `⌛ *${ref}* expired with no decision. Applicant notified.`,
  failing: (ref, n) => `⚠️ *${ref}*: couldn't reach the applicant after ${n} attempts. The bot will keep retrying.`,
};

// Resolves once WhatsApp's server has accepted the message (ack >= 1), rejects on error or timeout.
function createAckWaiter(client, { timeoutMs = ACK_TIMEOUT_MS } = {}) {
  const waiting = new Map();   // message id → settle(err)

  client.on('message_ack', (msg, ack) => {
    const settle = msg && msg.id && waiting.get(msg.id._serialized);
    if (!settle) return;
    if (ack >= 1) settle(null);
    else if (ack === -1) settle(new Error('WhatsApp reported a send error'));
  });

  return function waitForAck(message) {
    const id = message && message.id && message.id._serialized;
    if (!id) return Promise.reject(new Error('send returned no message'));
    if (message.ack >= 1) return Promise.resolve();
    if (message.ack === -1) return Promise.reject(new Error('WhatsApp reported a send error'));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        waiting.delete(id);
        // The ack event may have been missed: ask WhatsApp for the message's current state
        try {
          const fresh = typeof client.getMessageById === 'function' ? await client.getMessageById(id) : null;
          if (fresh && fresh.ack >= 1) return resolve();
        } catch { /* fall through */ }
        reject(new Error(`no delivery confirmation within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      waiting.set(id, err => {
        clearTimeout(timer);
        waiting.delete(id);
        return err ? reject(err) : resolve();
      });
    });
  };
}

function createDelivery({ approvals, letters, sendText, sendFile, waitForAck, getGroupId, log = console }) {
  const inFlight = new Set();
  const failures = new Map();   // ref → failed attempts (in memory; resets on restart)

  async function noteGroup(text) {
    const gid = String(getGroupId() || '').trim();
    if (!gid.endsWith('@g.us')) return;
    try { await sendText(gid, text); }
    catch (e) { log.error('[permit] group note failed:', e.message); }
  }

  // Delivers the outcome of one decided request. Returns true if the applicant was notified now.
  // Never throws: failures are logged and left for deliverOutstanding() to retry.
  async function deliver(ref) {
    if (inFlight.has(ref)) return false;
    inFlight.add(ref);
    try {
      const r = approvals.getRequest(ref);   // null once purged
      if (!r || r.status === 'PENDING' || r.client_notified_at) return false;

      let message;
      if (r.status === 'APPROVED') {
        const pdfPath = await letters.issueLetter(ref);
        message = await sendFile(r.client_jid, pdfPath, CLIENT.approved(r));
      } else if (r.status === 'REJECTED') {
        message = await sendText(r.client_jid, CLIENT.rejected(r));
      } else {
        message = await sendText(r.client_jid, CLIENT.expired(r));
      }
      await waitForAck(message);

      approvals.markClientNotified(ref);
      failures.delete(ref);
      await noteGroup(GROUP[r.status](ref));
      return true;
    } catch (e) {
      const n = (failures.get(ref) || 0) + 1;
      failures.set(ref, n);
      log.error(`[permit] delivering ${ref} failed (attempt ${n}):`, e.message);   // ref only, no PII
      if (n === WARN_AFTER_FAILURES) await noteGroup(GROUP.failing(ref, n));
      return false;
    } finally {
      inFlight.delete(ref);
    }
  }

  // Retries every decided request whose applicant hasn't been notified. Returns the number delivered.
  async function deliverOutstanding() {
    let delivered = 0;
    for (const ref of approvals.listUndelivered()) {
      if (await deliver(ref)) delivered++;
    }
    return delivered;
  }

  return { deliver, deliverOutstanding };
}

module.exports = { createDelivery, createAckWaiter };
