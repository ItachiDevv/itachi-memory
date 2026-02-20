# ---- Base: Node (includes npm) + Bun ----
FROM node:23-slim AS base

WORKDIR /app

# Tools needed by bun install / native deps occasionally
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL=/root/.bun
ENV PATH="$BUN_INSTALL/bin:/app/node_modules/.bin:$PATH"

# ---- Install deps (copy scripts early because your install references it) ----
COPY package.json bun.lock* ./
COPY scripts ./scripts
# If you have these folders, keep them early too (harmless if they don't exist in your repo)
# COPY patches ./patches

RUN bun install --frozen-lockfile

# ---- App source ----
COPY . .

# If your repo has a build step, keep it. If it doesn't, this will fail:
# remove this line if your project is runtime-only.
RUN bun run build

# ---- Runtime ----
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

# IMPORTANT: no --host flag (it breaks). Bind via HOST env.
CMD ["bash", "-lc", "bunx elizaos start --port ${PORT}"]