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

function createPermitWorkflow({ client, db, getSettings, outDir, renderPdf, log = console, maintenanceIntervalMs }) {
  const approvals = createApprovalDb(db);
  const getGroupId = () => getSettings().admin_group_id;

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

  async function onReady() {
    if (!String(getGroupId() || '').trim()) {
      try { await logGroups(client, log); } catch (e) { log.error('[permit] listing groups failed:', e.message); }
    }
    maintenance.start();
  }

  return {
    handleMessage, onReady,
    stop: () => maintenance.stop(),
    runMaintenance: () => maintenance.runOnce(),
    approvals, letters,
  };
}

module.exports = { createPermitWorkflow };
