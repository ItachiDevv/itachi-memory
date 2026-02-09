# Mac Setup Guide (from scratch)

## 1. Prerequisites

```bash
brew install node gh
gh auth login
npm install -g @anthropic-ai/claude-code pm2
claude   # run once to authenticate
```

## 2. Clone and build

```bash
cd ~/itachi
git clone https://github.com/ItachiDevv/itachi-memory.git
cd itachi-memory/orchestrator
npm install
cp .env.example .env
```

## 3. Edit .env

```bash
nano .env
```

Fill in the required values:
```
SUPABASE_SERVICE_ROLE_KEY=<paste from Supabase dashboard or another machine>
ITACHI_MACHINE_ID=mac-air
ITACHI_MACHINE_NAME=air
ITACHI_WORKSPACE_DIR=/Users/itachisan/itachi-workspaces
```

The rest of the defaults in `.env.example` are fine.

## 4. Build and run

```bash
mkdir -p ~/itachi-workspaces
npm run build
node dist/index.js   # test foreground first
```

You should see:
```
[machine] Registered as "air"
[runner] Starting ...
[health] Listening on http://localhost:3001/health
[main] Orchestrator running. Press Ctrl+C to stop.
```

Once that works, Ctrl+C and switch to PM2:

```bash
pm2 start dist/index.js --name itachi-orchestrator
pm2 save
pm2 startup   # follow the printed command
```

## 5. Verify

```bash
curl http://localhost:3001/health
pm2 logs itachi-orchestrator --lines 20
```

Send a test task from Telegram and watch the logs.
