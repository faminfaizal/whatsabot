# whatsabot: API + Socket.io + built React client, one container on port 5000.
# Build context: this folder (docker compose does that).

# ── 1. Build the React client ───────────────────────────────────
FROM node:22-bookworm-slim AS client
WORKDIR /build/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ── 2. Server dependencies (git: Baileys pulls libsignal from GitHub; compilers: native fallback) ──
FROM node:22-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ── 3. Runtime ──────────────────────────────────────────────────
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    TZ=Asia/Kuala_Lumpur \
    PORT=5000
WORKDIR /app
COPY --from=deps /app/server/node_modules server/node_modules
COPY server/ server/
COPY --from=client /build/client/build client/build
# data/ (SQLite, settings, logs) and sessions/ (WhatsApp logins) are volumes
RUN mkdir -p server/data server/sessions && chown -R node:node server/data server/sessions
USER node
WORKDIR /app/server
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "index.js"]
