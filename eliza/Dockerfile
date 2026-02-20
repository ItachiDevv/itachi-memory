# ===== Base: Bun =====
FROM oven/bun:1.1

WORKDIR /app

# ===== System deps + Node 20 (NOT Debian's old nodejs) =====
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends \
    ca-certificates curl gnupg openssh-client \
  && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x + npm
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends nodejs \
  && node -v && npm -v \
  && rm -rf /var/lib/apt/lists/*

# (Optional) if you truly need Codex inside the container:
# RUN npm i -g @openai/codex

# ===== Install deps (cache-friendly) =====
COPY package.json bun.lock* ./
COPY scripts/ scripts/
RUN bun install --frozen-lockfile || bun install

# ===== Copy app + build =====
COPY . .
RUN bun run build

# ===== Entrypoint for SSH keys (your file) =====
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# IMPORTANT: no --host (elizaos doesn't support it)
CMD ["bash", "-lc", "bunx elizaos start --port ${PORT:-3000}"]