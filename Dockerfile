# SoulCloud platform (API, broker auth, ingest, sweeper).
FROM oven/bun:1.4.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PRISMA_DISABLE_TELEMETRY=1 \
    DO_NOT_TRACK=1 \
    DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json prisma.config.ts ./
COPY migrations ./migrations
COPY src ./src
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 8080 8081
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
# Migrations: docker compose runs `bun --bun run db:deploy` in this image first.
CMD ["bun", "src/main.ts"]
