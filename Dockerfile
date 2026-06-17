# ─── Polymarket BTC 15-min MM Bot ──────────────────────
# Multi-stage build for minimal production image
# Build: docker build -t polybort .
# Run:   docker compose up -d

# ── Stage 1: Install dependencies ─────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json bun.lock* package-lock.json* ./
RUN corepack enable && \
    if [ -f bun.lock ]; then \
      bun install --frozen-lockfile --production=false; \
    elif [ -f package-lock.json ]; then \
      npm ci; \
    else \
      npm install; \
    fi

# ── Stage 2: Build ────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN npm run build

# ── Stage 3: Production ──────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Security: run as non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone build output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/data?type=status || exit 1

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
