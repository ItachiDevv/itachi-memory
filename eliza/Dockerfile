FROM oven/bun:1.1
WORKDIR /app

# Install deps first (cache layer)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Copy source and build
COPY . .
RUN bun run build

EXPOSE 3000

# ElizaOS uses PORT env var (default 3000)
ENV NODE_ENV=production
CMD ["bun", "run", "start"]
