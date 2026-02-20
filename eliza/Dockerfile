FROM node:20-bookworm-slim

WORKDIR /app

# Install OS deps (ssh client + curl/unzip for bun installer)
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      openssh-client \
      ca-certificates \
      curl \
      unzip \
 && rm -rf /var/lib/apt/lists/*

# Install Bun
ENV BUN_INSTALL=/root/.bun
ENV PATH="$BUN_INSTALL/bin:$PATH"
RUN curl -fsSL https://bun.sh/install | bash

# Install Codex CLI globally (needs modern Node)
RUN npm i -g @openai/codex

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

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["bun", "run", "start"]