// Run: node --test limiter.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('./limiter');

test('counts hits per key inside the window and forgets them afterwards', () => {
  let t = 1_000_000;
  const l = createLimiter({ windowMs: 60_000, now: () => t });
  l.add('a'); l.add('a'); l.add('b');
  assert.equal(l.count('a'), 2);
  assert.equal(l.count('b'), 1);
  assert.equal(l.count('nobody'), 0);
  t += 59_000; l.add('a');
  assert.equal(l.count('a'), 3);
  t += 2_000;   // the first two hits are now 61 s old
  assert.equal(l.count('a'), 1);
  assert.equal(l.count('b'), 0);
});
