FROM oven/bun:1.1.45

WORKDIR /app

# System deps + Node 20 (needed because tsup runs via `node`)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 make g++ \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && npm -v && node -v \
  && npm i -g @openai/codex \
  && rm -rf /var/lib/apt/lists/*

# Install deps first (better caching)
COPY package.json ./
COPY bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

# App source + build
COPY . .
RUN bun run build

ENV PORT=3000
EXPOSE 3000

# Bind to 0.0.0.0 for Coolify and use $PORT
CMD ["sh", "-lc", "bun run start -- --host 0.0.0.0 --port ${PORT:-3000}"]