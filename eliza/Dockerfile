FROM oven/bun:1.1
WORKDIR /app

# Install SSH client (for remote machine control via Tailscale) + Node/npm (for Codex CLI)
# Then install Codex CLI globally.
RUN apt-get update -qq \
 && apt-get install -y -qq openssh-client nodejs npm \
 && npm i -g @openai/codex \
 && rm -rf /var/lib/apt/lists/*

# Install deps first (cache layer)
COPY package.json bun.lock* ./
COPY scripts/ scripts/
RUN bun install --frozen-lockfile || bun install

# Copy source and build
COPY . .
RUN bun run build

# Entrypoint sets up SSH keys from mounted volume
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 3000

ENV NODE_ENV=production

# IMPORTANT: make sure Next binds to 0.0.0.0 and uses $PORT at runtime
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["sh", "-lc", "next start -H 0.0.0.0 -p ${PORT:-3000}"]