# CLAUDE.md — WA Auto Messenger (whatsabot)

WhatsApp automation platform: multi-user sessions, message scheduling, bulk campaigns, anti-ban
protection, and an admin panel.

## Stack & ports
- Server: Express + **Socket.io** + **Baileys** (`@whiskeysockets/baileys`) WhatsApp client —
  `server/index.js`, port **5000**.
- Client: **CRA (React)** in `client/`; dev on port **3000** (proxies `/api` → 5000), production = `client/build` served by the server on the same port.
- Storage: **SQLite** via `better-sqlite3` at `server/data/whatsabot.db` (WAL mode). **Not Oracle.**

## Deploy (Docker)
Production runs from `docker-compose.yml`: whatsabot on 10.49.39.144:8058 (the API server also serves the built client), parking permit on :8059. See `DEPLOY.md`. One container per app (each holds WhatsApp logins). Env in `.env.whatsabot` / `.env.permit` (examples committed, real files gitignored). Data lives in volumes `whatsabot_data` (server/data), `whatsabot_sessions`, `permit_data`.

## Run (local dev)
```
cd server && npm install && npm start     # :5000
cd client && npm install && npm start     # :3000
```

## Server modules (`server/`)
- `index.js` — Express + Socket.io bootstrap.
- `whatsapp.js` — Baileys client lifecycle: `createClient`, `getClient`, QR generation. Sessions use
  `useMultiFileAuthState`, persisted under `server/sessions/<sessionId>/auth/`.
- `routes.js` — REST API; JWT (`jsonwebtoken`) auth, `adminAuth` middleware, session start/QR flow.
- `queue.js` — message send queue (scheduling, throttling / anti-ban).
- `scraper.js` — uses `cheerio`.
- `db.js` — `better-sqlite3` access layer. `middleware.js` — auth. `cleanup.js` — maintenance.

## Env (`server/.env`)
```
PORT=5000
CLIENT_URL=http://localhost:3000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=...          # required; admin login is refused if missing or "admin123"
ADMIN_JWT_SECRET=...        # required; refused if missing, "secret" or "changeme" (use 32+ random chars)
```

## Auth model
- **Users:** `POST /api/session/start` without a token issues a new session plus a random **session
  token** (only its SHA-256 is stored, in the `session_tokens` table). The browser keeps it in
  `localStorage.sessionToken` and sends `Authorization: Bearer <token>` on every user route.
  `userAuth` (middleware.js) derives the session from the token; a `:sessionId` param or
  `body.sessionId` must match it (else 403). A bare sessionId grants nothing; never trust one.
- **Socket.io:** `join_session` takes the **token**, not a sessionId. Emit only to session rooms
  (`io.to(sessionId)`); never `io.emit` QR codes, phone numbers or queue contents.
- **Admin:** JWT (HS256) from `/api/admin/login`, with a lockout after 5 failures per IP in 15 min.
  `PUT /admin/settings` accepts only the known integer keys, with range checks.
- Browsers from before tokens re-link by scanning the QR once; the duplicate-phone merge in
  `whatsapp.js` carries over credits and schedules.

## Connection, queue and scheduler behaviour
- **Startup:** `restoreQueue()` → scheduler → `initExistingSessions()` (reconnects every linked,
  non-banned session that isn't `logged_out`). Sessions no longer need a browser to come back.
- **Reconnect:** linked sessions retry forever with backoff (5s → 5 min); never-scanned QR sessions
  stop after 3. `loggedOut` clears `sessions/<id>/auth` and sets status `logged_out` (next start
  shows a fresh QR). `connectionReplaced` does not reconnect. Use `wa.isConnected(sid)` for
  "online"; a `clients[sid]` entry also exists while still connecting.
- **Queue:** persisted in `queue_jobs`. A job whose session is offline or cooling down **waits**
  (re-checked every 30s and when a session connects), failing only after 24h; missing user / banned /
  no credits fail immediately. One-off schedules go `pending → queued → sent|failed`.
  A job mid-send when the process dies is sent again after restart.
- **Scraper:** schedules are owned by the `system` users row (no phone; hidden from user lists,
  kept by `cleanup.js`) and sent from the first connected session. Imported msg_ids live in
  `scraper_imports` (dup check). The mark-fetched callback marks the whole feed, so it is only
  called when every pending row was stored; otherwise it is withheld and the result says why.

## Gotchas
- **Ignore the stray files** `{`, `console.log('Installed`, `console.error(e.message))`,
  `{routes,data,sessions}`, and `db - Copy.js` — accidental shell-redirect leftovers. Don't import them.
- `db.js` is authoritative; `db - Copy.js` is a stale backup.
- Throttle sends via `queue.js` — bypassing it risks WhatsApp bans.
