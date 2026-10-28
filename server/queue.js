const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const wa = require('./whatsapp');

let io = null;
let isProcessing = false;
let isPaused = false;
let retryTimer = null;
const queue = []; // in-memory view of the queue_jobs table (the table survives restarts)

const RETRY_MS = 30 * 1000;                // re-check jobs waiting on an offline / cooling-down session
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;   // give up on a job whose session stays unavailable this long

function setIO(socketIO) { io = socketIO; }
function pauseQueue() { isPaused = true; }
function resumeQueue() { isPaused = false; processNext(); }
function isQueuePaused() { return isPaused; }

function getQueue() { return queue; }

// Inserts after every job of equal or higher priority (FIFO within a priority)
function insertSorted(entry) {
  let insertIdx = queue.length;
  for (let i = 0; i < queue.length; i++) {
    if (entry.priority < queue[i].priority) { insertIdx = i; break; }
  }
  queue.splice(insertIdx, 0, entry);
}

function addToQueue(job) {
  const entry = {
    id: uuidv4(),
    sessionId: job.sessionId,
    to: job.to,
    message: job.message,
    priority: job.priority ?? 2, // 0=instant, 1=scheduled, 2=campaign
    scheduledAt: job.scheduledAt || new Date().toISOString(),
    campaignId: job.campaignId || null,
    scheduleId: job.scheduleId || null, // set for one-off schedules, so the result is written back
    createdAt: new Date().toISOString(),
    status: 'pending',
  };

  db.insertQueueJob(entry);
  insertSorted(entry);

  emitQueue(entry.sessionId);
  if (!isProcessing && !isPaused) processNext();
  return entry;
}

// Reloads unsent jobs after a restart. A job that was mid-send when the process died is sent again.
function restoreQueue() {
  const jobs = db.getQueue();
  for (const j of jobs) insertSorted({ ...j, status: 'pending' });
  if (jobs.length) {
    console.log(`📬 Restored ${jobs.length} queued message(s)`);
    processNext();   // sessions are still connecting, so most will wait for their onReady
  }
}

// Removes a job. With sessionId, only if the job belongs to that session. Returns true if removed.
function removeFromQueue(jobId, sessionId) {
  const idx = queue.findIndex(j => j.id === jobId && (!sessionId || j.sessionId === sessionId));
  if (idx === -1) return false;
  const [job] = queue.splice(idx, 1);
  db.deleteQueueJob(job.id);
  emitQueue(job.sessionId);
  return true;
}

function clearQueue() {
  const sessions = new Set(queue.map(j => j.sessionId));
  queue.splice(0, queue.length);
  db.clearQueueJobs();
  sessions.forEach(emitQueue);
}

// Each session's room only sees its own jobs (the admin dashboard polls /api/admin/queue)
function emitQueue(sessionId) {
  if (io && sessionId) io.to(sessionId).emit('queue_updated', getQueueStats(sessionId));
}

// Without sessionId: whole queue (admin). With sessionId: that session's jobs only.
function getQueueStats(sessionId) {
  const users = db.getUsers();
  const jobs = sessionId ? queue.filter(j => j.sessionId === sessionId) : queue;
  return {
    total: jobs.length,
    paused: isPaused,
    jobs: jobs.slice(0, 20).map(j => ({
      ...j,
      userName: users[j.sessionId]?.name || j.sessionId,
      message: j.message?.substring(0, 50),
    })),
  };
}

function randomDelay(min, max) {
  return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; processNext(); }, RETRY_MS);
}

// Ends a job: drops it from the queue + table and records the outcome on its schedule
function finishJob(job, ok, error) {
  const idx = queue.indexOf(job);
  if (idx > -1) queue.splice(idx, 1);
  db.deleteQueueJob(job.id);
  if (job.scheduleId) db.setScheduleStatus(job.scheduleId, ok ? 'sent' : 'failed');
  if (!ok && error) console.error(`Queue job failed [${job.id}]:`, error);
  emitQueue(job.sessionId);
}

// What to do with a job right now: 'send', 'wait' (session offline / cooling down) or 'fail: reason'
function jobState(job, now) {
  const user = db.getUser(job.sessionId);
  if (!user) return 'fail: User not found';
  if (user.banned) return 'fail: Banned';
  if (user.credits <= 0) return 'fail: No credits';
  const available = wa.isConnected(job.sessionId)
    && !(user.cooldownUntil && now < new Date(user.cooldownUntil).getTime());
  if (available) return 'send';
  if (now - new Date(job.createdAt).getTime() > MAX_WAIT_MS) return 'fail: Session unavailable for 24h';
  return 'wait';
}

async function processNext() {
  if (isProcessing || isPaused || queue.length === 0) return;
  isProcessing = true;

  // First job that can go now; permanently failing jobs are dropped along the way
  const now = Date.now();
  let job = null;
  for (const candidate of [...queue]) {
    const state = jobState(candidate, now);
    if (state === 'send') { job = candidate; break; }
    if (state.startsWith('fail')) {
      const reason = state.slice(6);
      db.addUserLog(candidate.sessionId, {
        to: candidate.to, toDisplay: candidate.to,
        message: candidate.message.substring(0, 100), status: 'failed', error: reason,
      });
      finishJob(candidate, false, reason);
    }
  }

  if (!job) {
    isProcessing = false;
    if (queue.length > 0) scheduleRetry();   // everything left is waiting on a session
    return;
  }

  job.status = 'sending';
  emitQueue(job.sessionId);

  let ok = false, error = null;
  try {
    await wa.sendMessage(job.sessionId, job.to, job.message);
    ok = true;
  } catch (err) {
    error = err.message;   // sendMessage already logged it and applied failure cooldown
  }
  finishJob(job, ok, error);

  const settings = db.getSettings();
  await randomDelay(settings.minDelayMs, settings.maxDelayMs);

  isProcessing = false;
  if (queue.length > 0) processNext();
}

// Next run strictly after `now`, so a schedule missed during downtime fires once, not once per
// missed interval. Monthly runs clamp to the last day of shorter months (31 Jan → 28/29 Feb).
function nextRun(from, repeat, now) {
  const next = new Date(from);
  const step = () => {
    if (repeat === 'hourly') next.setHours(next.getHours() + 1);
    else if (repeat === 'daily') next.setDate(next.getDate() + 1);
    else if (repeat === 'weekly') next.setDate(next.getDate() + 7);
    else if (repeat === 'daily-weekday') {
      next.setDate(next.getDate() + 1);
      if (next.getDay() === 6) next.setDate(next.getDate() + 2);
      else if (next.getDay() === 0) next.setDate(next.getDate() + 1);
    } else if (repeat === 'monthly') {
      const day = next.getDate();
      next.setDate(1);
      next.setMonth(next.getMonth() + 1);
      const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(day, lastDay));
    } else return false;
    return true;
  };
  for (let i = 0; i < 100000; i++) {   // bounded: hourly over 10 years is ~88k steps
    if (!step()) return null;
    if (next > now) return next;
  }
  return null;
}

// Process scheduled messages every minute
function startScheduler() {
  const cron = require('node-cron');
  cron.schedule('* * * * *', () => {
    const users = db.getUsers();
    const now = new Date();

    for (const sessionId of Object.keys(users)) {
      const schedules = db.getUserSchedules(sessionId);
      let changed = false;

      schedules.forEach(s => {
        if (s.status !== 'pending') return;
        const scheduledTime = new Date(s.scheduledAt);
        if (scheduledTime <= now) {

          // Resolve actual sender — pick any connected session for 'system'
          let actualSessionId = sessionId;
          if (sessionId === db.SYSTEM_SESSION_ID) {
            const connected = Object.keys(wa.getAllClients())
              .filter(sid => sid !== db.SYSTEM_SESSION_ID && wa.isConnected(sid));
            if (connected.length === 0) {
              console.log(`⚠️ System schedule skipped — no connected sessions`);
              return; // try again next minute
            }
            actualSessionId = connected[0];
            console.log(`📤 System schedule → assigned to session: ${actualSessionId}`);
          }

          const once = s.repeat === 'once' || !s.repeat;
          addToQueue({
            sessionId: actualSessionId,
            to: s.to,
            message: s.message,
            priority: 1,
            scheduledAt: s.scheduledAt,
            scheduleId: once ? s.id : null,
          });

          if (once) {
            s.status = 'queued';   // becomes 'sent' / 'failed' when the job finishes
          } else {
            const next = nextRun(scheduledTime, s.repeat, now);
            if (next) s.scheduledAt = next.toISOString();
            else s.status = 'failed';   // unknown repeat value: stop instead of firing every minute
          }
          changed = true;
        }
      });

      if (changed) db.saveUserSchedules(sessionId, schedules);
    }
  });
  console.log('Scheduler started');
}

module.exports = {
  setIO, addToQueue, removeFromQueue, clearQueue, restoreQueue, processNext,
  getQueue, getQueueStats, pauseQueue, resumeQueue, isQueuePaused, startScheduler, nextRun,
};
