FROM oven/bun:1.1
WORKDIR /app

# Install SSH client + Node/npm (for Codex CLI)
RUN apt-get update -qq \
 && apt-get install -y -qq openssh-client nodejs npm \
 && npm i -g @openai/codex \
 && rm -rf /var/lib/apt/lists/*

# Copy repo first so postinstall scripts exist (important)
COPY . .

# Install deps (use bun.lockb if present; fallback allowed)
RUN bun install --frozen-lockfile || bun install

# Build
RUN bun run build

# Entrypoint sets up SSH keys from mounted volume
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 3000
ENV NODE_ENV=production

ENTRYPOINT ["/docker-entrypoint.sh"]

# Force bind + PORT (Coolify sets PORT, default 3000)
CMD ["sh","-c","bun x next start -H 0.0.0.0 -p ${PORT:-3000}"]