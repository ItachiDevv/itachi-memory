# Mac Setup Guide (from scratch)

## 1. Install prerequisites

```bash
brew install node gh
gh auth login
npm install -g @anthropic-ai/claude-code
```

> **Note:** On macOS 12 (Monterey) or older, `brew install` compiles from source and can take over an hour. This is normal.

## 2. Clone the repo

```bash
cd ~/Documents
git clone https://github.com/ItachiDevv/itachi-memory.git
cd itachi-memory
```

## 3. Set up Supabase credentials

Create the credentials file that all tools read from:

```bash
cat > ~/.supabase-credentials << 'EOF'
SUPABASE_URL=<paste your Supabase URL>
SUPABASE_KEY=<paste your Supabase key>
EOF
```

Or pull them from a device that already has them (via Tailscale, AirDrop, password manager, etc.)

## 4. Pull encrypted .env from Supabase

The orchestrator `.env` was pushed from the Windows PC using `itachi-secrets`. Pull and decrypt it:

```bash
cd ~/Documents/itachi-memory/tools
npm install
npx tsc
cd ..
node tools/dist/itachi-secrets.js pull orchestrator-env --out orchestrator/.env
```

Enter the same passphrase that was used when pushing.

Then edit `orchestrator/.env` to set Mac-specific values:

```bash
nano orchestrator/.env
```

Change these two lines:
```
ITACHI_ORCHESTRATOR_ID=macbook
ITACHI_WORKSPACE_DIR=/Users/itachisan/itachi-workspaces
```

## 5. Create workspace directory

```bash
mkdir -p ~/itachi-workspaces
```

## 6. Build the orchestrator

```bash
cd ~/Documents/itachi-memory/orchestrator
npm install
npm run build
```

## 7. Run it

### Foreground (for testing)
```bash
node dist/index.js
```

### Background with PM2 (recommended)

PM2 keeps it running after you close the terminal, restarts on crash, and auto-starts on boot.

```bash
npm install -g pm2
cd ~/Documents/itachi-memory/orchestrator
pm2 start dist/index.js --name itachi-orchestrator
pm2 save
pm2 startup
# ^ Copy and run the command it prints
```

Useful PM2 commands:
```bash
pm2 status                    # See running processes
pm2 logs itachi-orchestrator  # Tail logs
pm2 restart itachi-orchestrator
pm2 stop itachi-orchestrator
```

## 8. Verify

```bash
# Health check
curl http://localhost:3001/health

# Or send a task from Telegram:
# /task itachi-memory Add a test file
# Watch the orchestrator logs pick it up
```

## 9. Install hooks (optional)

If you'll also run Claude Code manually on this Mac:

```bash
mkdir -p ~/.claude/hooks
cp ~/Documents/itachi-memory/hooks/unix/after-edit.sh ~/.claude/hooks/
cp ~/Documents/itachi-memory/hooks/unix/session-start.sh ~/.claude/hooks/
cp ~/Documents/itachi-memory/hooks/unix/session-end.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/*.sh
```

Then merge the hook config from `config/settings-hooks.json` into `~/.claude/settings.json`.
