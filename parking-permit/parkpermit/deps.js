// deps.js — loads third-party packages without npm install.
//
// The production server has no internet, so this app borrows the packages whatsabot already has:
//   better-sqlite3         → whatsabot/node_modules        (found by normal require resolution)
//   baileys, express, …    → whatsabot/server/node_modules (via serverRequire)
// Override the server folder with WHATSABOT_SERVER_DIR if the layout differs.
'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

const SERVER_DIR = process.env.WHATSABOT_SERVER_DIR || path.resolve(__dirname, '..', '..', 'server');
const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));

// Normal resolution first (own node_modules / parent folders), then whatsabot's server folder
function load(name) {
  try { return require(name); }
  catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    return serverRequire(name);
  }
}

module.exports = { load, serverRequire, SERVER_DIR };
