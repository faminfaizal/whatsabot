# 💬 WA Auto Messenger

A full-featured WhatsApp automation platform with multi-user support, message scheduling, bulk campaigns, anti-ban protection, and an admin panel.

---

## ⚡ Quick Start

### 1. Prerequisites

- **Node.js v18+** — https://nodejs.org (download LTS)
- **npm v8+** — comes with Node.js

Verify:
```bash
node --version   # should show v18+
npm --version    # should show v8+
```

For **Ubuntu/Linux**, also install Chromium dependencies:
```bash
sudo apt-get install -y chromium-browser libgbm-dev libasound2 libatk1.0-0 libcairo2 libcups2 libnss3 libxss1
```

---

### 2. Install Dependencies

```bash
# Install backend
cd server
npm install

# Install frontend
cd ../client
npm install
```

---

### 3. Configure Environment

Edit `server/.env` if needed:

```env
PORT=5000
CLIENT_URL=http://localhost:3000

ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123        ← CHANGE THIS!
ADMIN_JWT_SECRET=changeme      ← CHANGE THIS!

DEFAULT_CREDITS=100
MIN_DELAY_MS=3000
MAX_DELAY_MS=8000
MAX_PER_RUN=50
MAX_PER_HOUR=30
MAX_PER_DAY=200
SAFE_HOURS_START=8
SAFE_HOURS_END=21
AUTO_PAUSE_FAILURES=3
COOLDOWN_MINUTES=5
```

---

### 4. Run the App

Open **two terminals**:

**Terminal 1 — Backend:**
```bash
cd server
npm start
```

**Terminal 2 — Frontend:**
```bash
cd client
npm start
```

Then open: **http://localhost:3000**

---

## 📱 Usage

1. Open http://localhost:3000
2. Click **Connect WhatsApp**
3. Scan the QR code with your phone's WhatsApp
4. You're connected! Your contacts load automatically.

---

## 🔧 Admin Panel

Open: **http://localhost:3000/admin**

Default credentials:
- Username: `admin`
- Password: `admin123`

**Change these in `server/.env` before deploying!**

---

## 📁 Project Structure

```
whatsapp-app/
  server/           ← Node.js + Express backend (port 5000)
    index.js        ← Entry point
    whatsapp.js     ← WhatsApp client manager
    queue.js        ← Global outbox queue
    routes.js       ← API endpoints
    db.js           ← JSON file database
    sessions/       ← Per-user data (auto-created)
    data/           ← Global data (auto-created)
    .env            ← Configuration

  client/           ← React frontend (port 3000)
    src/
      pages/        ← Main screens
      components/   ← Reusable components
      context/      ← Global state
```

---

## 🛡️ Anti-Ban Features

- Random humanized delay between sends (3–8s by default)
- Daily and hourly send limits per user
- Auto-pause after consecutive failures with cooldown
- Safe hours window (8AM–9PM by default)
- Credit system prevents overuse

---

## 💳 Credits

- Each new user gets **100 credits** on first scan
- **1 credit** deducted per successful message sent
- Failed sends do **not** deduct credits
- Admin can add credits to any user

---

## ⚠️ Important Notes

- Your **phone must stay connected to the internet** at all times
- WhatsApp Web is run headlessly inside the app — no browser tab needed
- Sessions are saved locally so you only scan QR **once**
- This uses unofficial WhatsApp Web automation — use responsibly

---

## 🔌 Ports

| Service | Port |
|---------|------|
| Frontend | 3000 |
| Backend | 5000 |
