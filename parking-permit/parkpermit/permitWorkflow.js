// permitWorkflow.js — wires every permit module to one WhatsApp client. The single entry point.
//
//   const workflow = createPermitWorkflow({ client, db, getSettings, outDir, renderPdf });
//   onMessages: m => workflow.handleMessage(client.wrapIncoming(m))
//   onOpen:     () => workflow.onReady()      // logs group IDs if none is set, starts maintenance
//   onClose:    () => workflow.stop()
//
// client: baileysAdapter's createBaileysClient (or any object with the same surface).
// getSettings() must return the CURRENT settings on every call (settings.js does).
'use strict';

const createApprovalDb = require('./approvalDb');
const { createIntake } = require('./intake');
const { createAdminGroup, logGroups } = require('./adminGroup');
const { createApprovalListener } = require('./approvalListener');
const { createLetterService } = require('./letter');
const { createDelivery, createAckWaiter } = require('./delivery');
const { createMaintenance } = require('./maintenance');

const OUTAGE_ALERT_MS = 10 * 60_000;   // tell the admin group about an offline stretch at least this long
const HEARTBEAT_MS = 60_000;            // how often 'last online' is recorded while connected

// Malaysia time, e.g. "28 Oct, 3:56 PM" (UTC+8, no DST)
function fmtMYT(ms) {
  const d = new Date(ms + 8 * 3600e3);
  const h = d.getUTCHours();
  return `${d.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]}, ${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function createPermitWorkflow({ client, db, getSettings, outDir, renderPdf, log = console, maintenanceIntervalMs,
                               now = Date.now, outageAlertMs = OUTAGE_ALERT_MS, heartbeatMs = HEARTBEAT_MS }) {
  const approvals = createApprovalDb(db);

  // Tiny key/value table: when the bot was last connected (survives restarts and crashes)
  db.exec('CREATE TABLE IF NOT EXISTS bot_state (key TEXT PRIMARY KEY, value TEXT)');
  const getState = key => (db.prepare('SELECT value FROM bot_state WHERE key = ?').get(key) || {}).value ?? null;
  const setState = (key, value) => db.prepare('INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  let heartbeat = null;
  const getGroupId = () => getSettings().admin_group_id;
  const getMaxPerDay = () => getSettings().max_requests_per_day ?? 5;

  const letters = createLetterService({
    approvals, outDir, renderPdf, log,
    getLetterhead: () => getSettings().letterhead,
  });
  const delivery = createDelivery({
    approvals, letters, log, getGroupId,
    sendText: (to, text) => client.sendText(to, text),
    sendFile: (to, filePath, caption) => client.sendFile(to, filePath, caption),
    waitForAck: createAckWaiter(client),
  });
  const adminGroup = createAdminGroup({
    approvals, log, getGroupId,
    send: (to, text) => client.sendText(to, text),
  });
  const intake = createIntake({
    approvals, log,
    send: (to, text) => client.sendText(to, text),
    getTimeoutHours: () => getSettings().approval_timeout_hours ?? 36,
    onCreated: ref => adminGroup.postRequest(ref),
    getMaxPerDay, now,
  });
  const listener = createApprovalListener({
    approvals, log, getGroupId,
    getApprovers: () => getSettings().admin_approvers,
    onApproved: ref => delivery.deliver(ref),
    onRejected: ref => delivery.deliver(ref),
  });
  const maintenance = createMaintenance({
    approvals, adminGroup, delivery, outDir, log,
    deleteGroupMessage: id => client.deleteMessage(id),
    ...(maintenanceIntervalMs ? { intervalMs: maintenanceIntervalMs } : {}),
  });

  // Returns true if the message was a permit DM or an admin command. Never throws.
  async function handleMessage(msg) {
    try {
      return (await intake.handle(msg)) || (await listener.handle(msg));
    } catch (e) {
      log.error('[permit] handling a message failed:', e.message);   // message text never logged
      return false;
    }
  }

  // Connected again: if the bot was away a while, say so in the admin group (nothing about applicants)
  async function reportOutage() {
    const last = Number(getState('last_online'));
    const gid = String(getGroupId() || '').trim();
    if (last && now() - last >= outageAlertMs && gid.endsWith('@g.us')) {
      const mins = Math.round((now() - last) / 60000);
      const text = `⚠️ The permit bot was offline for about ${mins >= 120 ? Math.round(mins / 60) + ' hours' : mins + ' minutes'} (${fmtMYT(last)} – ${fmtMYT(now())}). Anyone who wrote to it during that time may need to send their request again.`;
      try { await client.sendText(gid, text); } catch (e) { log.error('[permit] outage notice failed:', e.message); }
    }
    setState('last_online', now());
  }

  async function onReady() {
    await reportOutage();
    clearInterval(heartbeat);
    heartbeat = setInterval(() => { try { setState('last_online', now()); } catch {} }, heartbeatMs);
    heartbeat.unref?.();
    if (!String(getGroupId() || '').trim()) {
      try { await logGroups(client, log); } catch (e) { log.error('[permit] listing groups failed:', e.message); }
    }
    maintenance.start();
  }

  return {
    handleMessage, onReady,
    stop: () => {
      clearInterval(heartbeat);
      heartbeat = null;
      try { setState('last_online', now()); } catch {}   // last moment known to be connected
      maintenance.stop();
    },
    runMaintenance: () => maintenance.runOnce(),
    approvals, letters,
  };
}

module.exports = { createPermitWorkflow };
