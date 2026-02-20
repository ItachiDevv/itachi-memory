FROM oven/bun:1.1

WORKDIR /app

# System deps (ssh client + node/npm because some tooling expects it)
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends \
     openssh-client nodejs npm ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ---- IMPORTANT: stop ElizaOS CLI from trying to check npm for updates ----
ENV CI=1
ENV NO_UPDATE_NOTIFIER=1
ENV ELIZA_DISABLE_UPDATE_CHECK=1

# Install deps first (cache layer)
COPY package.json bun.lock* ./
COPY scripts/ scripts/
RUN bun install --frozen-lockfile || bun install

# Copy source and build
COPY . .
RUN bun run build

# Entrypoint (your existing script)
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

ENTRYPOINT ["/docker-entrypoint.sh"]

# DO NOT use `bun run start` if your package.json start includes `--host`
# Run the CLI directly, with ONLY the port.
CMD ["bunx", "--yes", "@elizaos/cli", "start", "--port", "3000"]