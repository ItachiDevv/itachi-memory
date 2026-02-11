# ============================================================
# Itachi Memory System — ElizaOS + Orchestrator (combined)
# ============================================================
# Build context: repo root (itachi-memory/)
# Runs both ElizaOS (API/Telegram) and Orchestrator (task
# runner / Claude CLI) side by side in one container.
# ============================================================

# --- Stage 1: Build ElizaOS ---
FROM oven/bun:1.1 AS eliza-build
WORKDIR /build
COPY eliza/package.json eliza/bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY eliza/ .
RUN bun run build

# --- Stage 2: Build Orchestrator ---
FROM node:22-slim AS orch-build
WORKDIR /build
COPY orchestrator/package.json orchestrator/package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev
COPY orchestrator/ .
RUN npm run build

# --- Stage 3: Runtime ---
FROM oven/bun:1.1

# Install Node.js 22 (orchestrator runs on Node, Claude CLI needs npm)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git procps \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Claude CLI and Codex CLI globally (orchestrator spawns sessions)
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Create workspace for orchestrator task checkouts
RUN mkdir -p /root/itachi-workspaces

WORKDIR /app

# Copy ElizaOS (built)
COPY --from=eliza-build /build /app/eliza

# Copy Orchestrator (built + node_modules)
COPY --from=orch-build /build /app/orchestrator

# Copy entrypoint script
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# ElizaOS API
EXPOSE 3000
# Orchestrator health
EXPOSE 3001

ENV NODE_ENV=production
# Default orchestrator workspace inside container
ENV ITACHI_WORKSPACE_DIR=/root/itachi-workspaces
# Telegram bot: Sonnet 4.5 for conversation (personality), Haiku 4.5 for background workers
ENV ANTHROPIC_LARGE_MODEL=claude-sonnet-4-5-20250929
ENV ANTHROPIC_SMALL_MODEL=claude-haiku-4-5-20251001

ENTRYPOINT ["/app/docker-entrypoint.sh"]
