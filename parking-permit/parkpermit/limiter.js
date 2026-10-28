// limiter.js — sliding-window counter per key (in memory; resets when the process restarts).
// Used by intake.js to stop one WhatsApp number flooding the bot or the admin group.
'use strict';

function createLimiter({ windowMs, now = Date.now }) {
  const hits = new Map();   // key → timestamps (ms) inside the window

  function live(key) {
    const cutoff = now() - windowMs;
    const kept = (hits.get(key) || []).filter(t => t > cutoff);
    if (kept.length) hits.set(key, kept); else hits.delete(key);
    return kept;
  }

  return {
    count: key => live(key).length,
    add(key) {
      const kept = live(key);
      kept.push(now());
      hits.set(key, kept);
      if (hits.size > 5000) for (const k of hits.keys()) live(k);   // keep memory bounded
    },
  };
}

module.exports = { createLimiter };
