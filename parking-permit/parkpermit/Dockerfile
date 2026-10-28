# Parking permit bot + admin page, one container on port 5100.
# Own WhatsApp number, own SQLite file. Chromium renders the PDF letters.
# Build context: parking-permit/parkpermit (docker compose does that).

FROM node:22-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    TZ=Asia/Kuala_Lumpur \
    PERMIT_HOST=0.0.0.0 \
    PERMIT_PORT=5100 \
    PERMIT_DATA_DIR=/data \
    CHROME_PATH=/usr/bin/chromium
# Chromium + fonts (Liberation = Arial metrics, so the letter lays out like the Windows preview)
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY *.js ./
COPY admin/ admin/
RUN rm -f *.test.js ecosystem.config.js \
 && mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 5100
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
