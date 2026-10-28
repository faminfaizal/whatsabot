# Handoff: parking permit app (standalone, own WhatsApp number)

The app lives in `parkpermit/`. It runs as its **own PM2 process with its own WhatsApp number** and its own
admin page. It does not change whatsabot; it only borrows the packages whatsabot already has installed
(`better-sqlite3`, Baileys, express, …), because the server has no internet.

## 1. Put the files in place (on the server)
Copy `parkpermit\` to `D:\whatsabot\parking-permit\parkpermit\` (so `..\..\server\node_modules` is whatsabot's).
Don't copy `parkpermit\data\` if it exists locally: it holds a WhatsApp login and test data.
`samples\` is reference only (example letters); it doesn't need to go on the server.

## 2. Configure and check
```bat
cd /d D:\whatsabot\parking-permit\parkpermit
copy .env.example .env
notepad .env                 :: admin user/password, a 32+ char PERMIT_JWT_SECRET, port (default 5100)
node --test                  :: expect all passing; the real-Chrome PDF tests run when Chrome is found
```
If Chrome isn't in the usual place, set `CHROME_PATH` in `.env`. If whatsabot's server folder isn't
`D:\whatsabot\server`, set `WHATSABOT_SERVER_DIR`.

## 3. Start it
```bat
pm2 start ecosystem.config.js
pm2 save
pm2 logs parking-permit --lines 50
```
Open `http://<server>:5100` from an office PC (allow the port in Windows Firewall if needed), sign in, then:
1. **Status → Link WhatsApp**, and scan the QR with the **bot's own phone** (WhatsApp → Linked devices).
2. Add the bot's number to the admin WhatsApp group. **Approvals →** pick the group, add approvers, save.
3. **Letter →** fill in the letterhead, upload the logo and parking map, **Preview letter**, save.

Then run the verification checklist in `parkpermit/tasks/todo.md` (task 10) with a test group and test phone.

## For a Claude Code session on the server
> Read `parkpermit/CLAUDE.md`, `parkpermit/tasks/todo.md` and `parkpermit/tasks/lessons.md`.
> The app is built and tested off-server. Help me run task 10 (on-server verification) step by step.
> Constraints: no internet (no npm install); don't touch whatsabot's own files or its WhatsApp sessions;
> run `node --test` in `parkpermit` before saying anything is done.
