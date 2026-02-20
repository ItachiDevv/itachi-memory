# syntax=docker/dockerfile:1

FROM oven/bun:1.1.45 AS base
WORKDIR /app

# ---- deps ----
FROM base AS deps
COPY package.json bun.lockb* ./
# IMPORTANT: your postinstall needs this file
COPY scripts ./scripts
RUN bun install --frozen-lockfile || bun install

# ---- build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# ---- run ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /app ./

EXPOSE 3000
CMD ["sh", "-lc", "bun run start -- --host 0.0.0.0 --port ${PORT}"]