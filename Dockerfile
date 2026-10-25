# MOA on Fly.io, Railway, or any Docker host. One instance: SQLite lives on a volume at /data.
FROM node:22-bookworm-slim AS build
# better-sqlite3 is native: build tools in case no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_PATH=/data/moa.db
COPY --from=build /app/package.json /app/next.config.ts ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
RUN mkdir -p /data
EXPOSE 3000
CMD ["sh", "-c", "exec node_modules/.bin/next start -H 0.0.0.0 -p ${PORT:-3000}"]
