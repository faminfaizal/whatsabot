// maintenance.js — the 5-minute job: expire overdue requests, retry queued group posts and
// deliveries, then purge PII from finished requests (and any stray letter files).
//
// Usage (whatsapp.js):
//   const maintenance = require('./maintenance').createMaintenance({
//     approvals, adminGroup, delivery,
//     outDir: 'D:\\whatsabot\\data\\permit-letters',                     // same folder as letter.js
//     deleteGroupMessage: async msgId => {                  // "delete for everyone"
//       const m = await client.getMessageById(msgId);
//       if (m) await m.delete(true);
//     },
//   });
//   client.on('ready', () => maintenance.start());          // runs now (catches up after downtime), then every 5 min
//   client.on('disconnected', () => maintenance.stop());
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INTERVAL_MS = 5 * 60_000;
const LETTER_FILE = /^(PP-\d{4,})\.pdf(\.tmp)?$/;

function createMaintenance({ approvals, adminGroup, delivery, outDir, deleteGroupMessage,
                             unlink = p => fs.promises.unlink(p), intervalMs = INTERVAL_MS, log = console }) {
  let running = false;
  let timer = null;

  // Removes PII for every finished request whose applicant has been notified (or force-purge age reached).
  async function purge() {
    let purged = 0;
    for (const { ref_no: ref, pdf_path: pdfPath, group_msg_id: msgId } of approvals.listPurgeable()) {
      // 1. Group summary: best effort (WhatsApp only allows delete-for-everyone for ~2 days)
      if (msgId) {
        try { await deleteGroupMessage(msgId); }
        catch (e) { log.warn(`[permit] could not delete group summary for ${ref}:`, e.message); }
      }
      // 2. Letter file: must be gone before the record is purged, otherwise retry next run
      if (pdfPath) {
        try { await unlink(pdfPath); }
        catch (e) {
          if (e.code !== 'ENOENT') {
            log.error(`[permit] could not delete letter for ${ref}, will retry:`, e.code || e.message);
            continue;
          }
        }
      }
      // 3. PII row + purged_at, in one transaction
      if (approvals.purgeRow(ref)) purged++;
    }
    return purged;
  }

  // Deletes letter files whose request is already purged or unknown (e.g. left by a crash).
  async function sweepOrphanFiles() {
    if (!outDir) return 0;
    let names;
    try { names = await fs.promises.readdir(outDir); }
    catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
    let removed = 0;
    for (const name of names) {
      const m = name.match(LETTER_FILE);
      if (!m) continue;
      const logRow = approvals.getLog(m[1]);
      if (logRow && !logRow.purged_at) continue;   // still in use
      try { await unlink(path.join(outDir, name)); removed++; }
      catch (e) { if (e.code !== 'ENOENT') log.error(`[permit] could not delete stray file ${name}:`, e.code || e.message); }
    }
    return removed;
  }

  // One full pass. Each step is isolated so one failure doesn't block the rest.
  async function runOnce() {
    if (running) return { skipped: true };
    running = true;
    const result = { expired: 0, posted: 0, delivered: 0, purged: 0, strayFiles: 0 };
    const step = async (name, fn) => {
      try { return await fn(); }
      catch (e) { log.error(`[permit] maintenance step "${name}" failed:`, e.message); return 0; }
    };
    try {
      result.expired = await step('expire', () => approvals.expireDue().length);
      result.posted = await step('post', () => adminGroup.postUnposted());
      result.delivered = await step('deliver', () => delivery.deliverOutstanding());
      result.purged = await step('purge', purge);
      result.strayFiles = await step('stray files', sweepOrphanFiles);
      return result;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    runOnce();
    timer = setInterval(runOnce, intervalMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, purge, sweepOrphanFiles, start, stop };
}

module.exports = { createMaintenance };
