# Bun base
FROM oven/bun:1.1.38

WORKDIR /app

# ---- System deps + Node 20 (for tsup/codex/anything that uses node) ----
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git openssh-client \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list \
  && apt-get update && apt-get install -y --no-install-recommends nodejs \
  && npm i -g @openai/codex \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# ---- Install deps ----
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

# ---- Build ----
COPY . .
RUN bun run build

# ---- Runtime ----
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

# If this is Next.js (you literally referenced next start):
CMD ["sh", "-lc", "bunx next start -H 0.0.0.0 -p ${PORT}"]