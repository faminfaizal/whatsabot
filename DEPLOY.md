# Deploying whatsabot + parking permit with Docker

| App | URL | Container port | Data volume |
|---|---|---|---|
| whatsabot (multi-user sender + admin) | http://10.49.39.144:8058 | 5000 | `whatsabot_data` (SQLite, settings, contacts CSV, logs) and `whatsabot_sessions` (WhatsApp logins) |
| parking permit (own number + admin page) | http://10.49.39.144:8059 | 5100 | `permit_data` (permit.db, settings, WhatsApp login, letters, logo/map) |

Each app holds a WhatsApp login, so each runs as **exactly one container** (never scale or run a second copy
against the same volume: WhatsApp disconnects the older one).

## 1. Configure
```bash
cp .env.whatsabot.example .env.whatsabot     # ADMIN_PASSWORD, ADMIN_JWT_SECRET (32+ chars), scraper URLs
cp .env.permit.example   .env.permit         # PERMIT_ADMIN_PASSWORD, PERMIT_JWT_SECRET (32+ chars)
```
Both admin logins are refused until their password/secret are set and not defaults.
Ports bind to `10.49.39.144` by default; set `BIND_IP` (shell or a root `.env`) to change it, or `0.0.0.0` for all interfaces.
Allow TCP 8058 and 8059 in the host firewall.

## 2. Build and start
**Server with internet (can reach Docker Hub, Debian mirrors, npmjs and github.com):**
```bash
docker compose up -d --build
docker compose ps            # both should become (healthy)
docker compose logs -f
```
**Server without internet:** build on any machine that has it, then ship the images:
```bash
docker compose build
docker save whatsabot:latest parking-permit:latest | gzip > whatsabot-images.tar.gz
# copy whatsabot-images.tar.gz, docker-compose.yml, .env.whatsabot, .env.permit to the server, then there:
gunzip -c whatsabot-images.tar.gz | docker load
docker compose up -d --no-build
```
The build needs github.com once (Baileys fetches `libsignal` from GitHub). The parking image is ~1 GB because it contains Chromium.

## 3. First run
- **whatsabot:** open `:8058`, each user clicks *Connect New WhatsApp* and scans their QR. Admin panel: `:8058/admin`.
- **parking permit:** open `:8059`, sign in, *Status → Link WhatsApp* (scan with the bot's own phone), then *Approvals* (admin group, approvers) and *Letter* (letterhead, logo, map, preview).
  Then run the checklist in `parking-permit/parkpermit/tasks/todo.md` (task 10) with a test group and phone.

## 4. Moving existing whatsabot data from the old server (D:\whatsabot)
Users keep their credits and schedules, but browsers must re-link once (a bare session id no longer logs anyone in).
Stop the old app first, then copy into the volumes (the container runs as user `node`, uid 1000):
```bash
docker compose up --no-start whatsabot
docker cp /path/to/old/server/data/.        whatsabot:/app/server/data/
docker cp /path/to/old/server/sessions/.    whatsabot:/app/server/sessions/
docker compose run --rm --no-deps --user root --entrypoint chown whatsabot -R node:node /app/server/data /app/server/sessions
docker compose up -d
```
Never run the old and the new app on the same WhatsApp sessions at the same time.

## 5. Operations
```bash
docker compose logs -f whatsabot            # or: parking
docker compose restart whatsabot            # reconnects all linked WhatsApp sessions by itself
docker compose pull; docker compose up -d --build     # update after `git pull`
docker run --rm -v whatsabot_whatsabot_data:/d -v "$PWD":/b alpine tar czf /b/whatsabot-data.tgz -C /d .   # back up data
```
(Volume names are prefixed with the compose project name `whatsabot_`.) Back up all three volumes: they hold
WhatsApp logins and, for the permit app, applicant data until it is purged.

## Notes
- Time zone is `Asia/Kuala_Lumpur` in both containers (schedules, safe hours, letter dates).
- Traffic is plain HTTP on the LAN. For HTTPS or a friendlier URL, put a reverse proxy in front (IIS ARR, nginx); both apps work behind one.
- If a container is `unhealthy`: `docker compose logs <service>`. The permit page shows "Chrome found" on Status once the renderer is available.
