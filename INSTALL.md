# Itachi Memory — Installation Guide

This documents the exact setup that works across all machines in the fleet. It is not a generic guide — it reflects what was actually done and the pitfalls that were hit along the way.

---

## Quick Reference

| What | Where |
|------|-------|
| Supabase project | `zhbchbslvwrgjbzakeap` |
| API URL | `https://itachisbrainserver.online` |
| Orchestrator .env | `orchestrator/.env` (copy from `.env.example`) |
| Passphrase file | `~/.itachi-key` (content: `itachidevv`) |
| API keys file | `~/.itachi-api-keys` |
| Hook symlinks (Unix) | `~/.claude/hooks/` → `hooks/unix/*.sh` |
| Hook symlinks (Windows) | `~/.claude/hooks/` → `hooks/windows/*.ps1` |

### Machine Fleet

| Name | Tailscale IP | User | OS | Notes |
|------|-------------|------|----|-------|
| itachisans-MacBook-Air | 100.103.124.46 | itachisan | macOS | primary dev machine |
| hoodie-prometh | 100.105.111.11 | newma | Windows | main Windows PC |
| surface-win | 100.106.148.100 | itachi | Windows | secondary Windows |
| hetzner-vps (itachi-mem) | 100.84.73.84 | root | Linux | VPS / Coolify host |

### SSH Keys

**Eliza bot public key** — add to `authorized_keys` on any machine the bot should SSH into:
```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDEi+5SsCJVtsj2sC9cMuaPO/JQMGTzOnrt9M9/zDKLE elizaos-bot@itachi-mem
```

**Shared deploy key** (Mac-to-machine SSH from the orchestrator) — stored at `~/.ssh/itachi_deploy`:
```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINlISu4xhChSSzLg5ErGjGitDRc1C339D+ZhHm9EsdkH itachi-deploy
```

Do NOT commit private keys or secrets anywhere in the repo.

---

## Prerequisites (All Platforms)

- Node.js 18+ (22+ preferred — see Windows section for a critical caveat)
- git
- Claude CLI with an active Max subscription (`claude` in PATH)
- Access to the Supabase service role key (ask the team or retrieve from Coolify env vars)

---

## Orchestrator .env Template

Create `orchestrator/.env` by copying `.env.example` and filling in the blanks:

```env
# Supabase (use the active project — NOT ecrnblpdaxglnllmctli)
SUPABASE_URL=https://zhbchbslvwrgjbzakeap.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<get from team>

# Machine identity — must be unique per machine
ITACHI_MACHINE_ID=<machine-name>
ITACHI_MACHINE_NAME=<machine-name>

# ElizaOS API
ITACHI_API_KEY=itachi_OkoYtQafDpx2rWFRNEIcioY6XZDQF0le
ITACHI_API_URL=https://itachisbrainserver.online

# Workspace — where task repos get cloned
# macOS:   /Users/yourname/itachi-workspaces
# Windows: C:\Users\yourname\itachi-workspaces
# Linux:   /root/itachi-workspaces
ITACHI_WORKSPACE_DIR=<path>

# Tuning (defaults are fine for most setups)
ITACHI_MAX_CONCURRENT=2
ITACHI_POLL_INTERVAL_MS=5000
ITACHI_TASK_TIMEOUT_MS=600000
ITACHI_DEFAULT_MODEL=opus
ITACHI_DEFAULT_BUDGET=5.00
```

> **PITFALL — wrong Supabase project**: There is an old, inactive project (`ecrnblpdaxglnllmctli`). If the orchestrator polls but never claims tasks, the first thing to check is which project the client is actually connecting to. The active project is `zhbchbslvwrgjbzakeap`.

> **PITFALL — dotenv does not override by default**: The orchestrator's dotenv config must use `override: true`. If stale values from `~/.itachi-api-keys` are already in the environment before the process starts, dotenv will silently keep the old values unless override is enabled. This is already set correctly in the codebase — do not change it.

---

## API Keys File (`~/.itachi-api-keys`)

This file is sourced on shell startup (via the Claude Code startup hook) and merged into the environment. Format is plain `KEY=VALUE`, one per line.

**PITFALL — pipe characters in values**: Values that contain `|` must be quoted, otherwise the shell treats `|` as a pipe and truncates the value. Example:

```bash
# WRONG — shell will pipe at the | character
COOLIFY_API_KEY=6|abc123...

# CORRECT
COOLIFY_API_KEY="6|abc123..."
```

This applies on all platforms. If an API key is mysteriously truncated, this is almost certainly the cause.

---

## Setup: The Fast Way (`install.mjs --full`)

**This is the correct way to set up a new machine.** `install.mjs --full` handles everything in one command: hooks, skills, MCP server, settings, API key sync, the `itachi` CLI wrapper, and the orchestrator. Do not follow the manual steps below unless something specific failed and you need to redo just that part.

### Step 1 — Prerequisites

- Node.js 22+ in PATH
- git
- Claude CLI (`claude` in PATH, active Max subscription)

> **Windows pitfall — old Node**: Windows machines often have Node v8 pre-installed. It won't work. Download the zip from nodejs.org, extract to `C:\Users\<user>\node22\`, and use it explicitly below.

### Step 2 — Clone + create passphrase file

**macOS / Linux:**
```bash
git clone https://github.com/ItachiDevv/itachi-memory.git ~/itachi-memory
echo -n "itachidevv" > ~/.itachi-key && chmod 600 ~/.itachi-key
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/ItachiDevv/itachi-memory.git C:\Users\<user>\Documents\itachi-memory
"itachidevv" | Out-File -Encoding ascii -NoNewline "$env:USERPROFILE\.itachi-key"
```

> The passphrase file (`~/.itachi-key`) must exist before running install. The installer reads it to decrypt synced keys.

### Step 3 — Run the installer

**macOS / Linux:**
```bash
cd ~/itachi-memory
node install.mjs --full
```

**Windows (PowerShell, using Node 22 zip):**
```powershell
$NODE = "C:\Users\<user>\node22\node-v22.14.0-win-x64\node.exe"
& $NODE C:\Users\<user>\Documents\itachi-memory\install.mjs --full
```

The installer will:
1. Pull API keys from encrypted sync
2. Install hooks (session-start, session-end, after-edit, user-prompt-submit)
3. Install skills (19 user skills synced from server)
4. Install MCP server
5. Configure `settings.json`
6. Sync Claude auth credentials
7. **Install the `itachi` CLI wrapper** to `~/.claude/` and npm global bin, and add both to PATH
8. Build and configure the orchestrator

> **What `itachi` is**: A wrapper around `claude` that loads API keys, runs session hooks, and accepts shortcut flags like `--ds` (dangerously-skip-permissions), `--c` (continue), `--cds` (continue + skip). Always use `itachi` instead of `claude` on machines in the fleet. If `itachi` is not recognized after install, open a new terminal — PATH changes require a new shell.

### Step 4 — Open a new terminal

PATH is updated by the installer but only takes effect in new shells. Close and reopen your terminal, then verify:

```bash
itachi --version   # should print claude version
```

---

## Platform-Specific Notes

### macOS — Orchestrator auto-start

The installer sets up the orchestrator, but to make it survive reboots create a launchd plist:

```bash
cat > ~/Library/LaunchAgents/com.itachi.orchestrator.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.itachi.orchestrator</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/yourname/itachi-memory/orchestrator/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key><string>/Users/yourname/itachi-memory/orchestrator</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/tmp/itachi-orchestrator.log</string>
    <key>StandardErrorPath</key><string>/tmp/itachi-orchestrator.err</string>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.itachi.orchestrator.plist
```

### Windows — SSH Server setup

Required so the bot and orchestrator can SSH into this machine.

**PITFALL — sshd defaults to DISABLED**: Must set start type before starting. Run in this exact order:

```powershell
# Run as Administrator
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
sc.exe config sshd start= auto    # ← this step is the one people miss
Start-Service sshd
Set-Service -Name sshd -StartupType 'Automatic'
```

**PITFALL — authorized_keys location for admin users**: If the user is in the `Administrators` group, SSH ignores `~\.ssh\authorized_keys`. Use:

```
C:\ProgramData\ssh\administrators_authorized_keys
```

```powershell
# Add the bot's public key to the file, then fix permissions:
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "SYSTEM:(F)" /grant "BUILTIN\Administrators:(F)"
```

**PITFALL — .txt extension**: Windows may silently add `.txt`. Verify with `dir C:\ProgramData\ssh\` and rename if needed.

### Windows — Orchestrator auto-start (Scheduled Task)

The installer builds the orchestrator but a Scheduled Task is needed for it to survive reboots:

```powershell
$NODE = "C:\Users\<user>\node22\node-v22.14.0-win-x64\node.exe"
$REPO = "C:\Users\<user>\Documents\itachi-memory"
$action = New-ScheduledTaskAction -Execute $NODE `
  -Argument "$REPO\orchestrator\dist\index.js" `
  -WorkingDirectory "$REPO\orchestrator"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "ItachiOrchestrator" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest
```

**PITFALL — `cd` across drives in cmd**: Always use `/d` flag: `cmd /c "cd /d C:\..."`.

### Linux / VPS — Orchestrator as systemd service

The installer builds the orchestrator. To run it as a persistent systemd service:

```bash
cat > /etc/systemd/system/itachi-orchestrator.service << 'EOF'
[Unit]
Description=Itachi Orchestrator
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/itachi-memory/orchestrator
ExecStart=/usr/bin/node /root/itachi-memory/orchestrator/dist/index.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable itachi-orchestrator
systemctl start itachi-orchestrator
```

Check logs: `journalctl -u itachi-orchestrator -f`

---

## Verifying a New Setup

After the orchestrator is running, confirm it's working:

1. **Check it connects to Supabase** — logs should say something like `Orchestrator started` and `Polling for tasks` with no auth errors.
2. **Send a test task via Telegram** — use `/task <project> <description>` and watch the logs.
3. **Check the correct Supabase project** — if the orchestrator polls but never claims, the machine is probably connecting to the wrong project. Re-check `SUPABASE_URL` in `.env`.
4. **Check dotenv override** — if env vars from `~/.itachi-api-keys` seem to override `.env`, the dotenv config must have `override: true`.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `itachi` not recognized after install | PATH not updated yet | Open a **new terminal** — PATH changes require a new shell |
| `itachi` still missing after new terminal | `install.mjs --full` was not run | Run `node install.mjs --full` from the repo root |
| Orchestrator polls but never claims tasks | Wrong Supabase project in `.env` | Check `SUPABASE_URL` — active project is `zhbchbslvwrgjbzakeap` |
| API key value is truncated | `\|` in value not quoted | Wrap value in double quotes in `~/.itachi-api-keys` |
| Stale env vars override `.env` | dotenv not using `override: true` | Already fixed in code; check you didn't revert it |
| SSH not accepting keys (Windows, Admin user) | Keys in wrong file | Use `C:\ProgramData\ssh\administrators_authorized_keys`, not `~\.ssh\authorized_keys` |
| SSH service won't start on Windows | Start type was DISABLED | Run `sc.exe config sshd start= auto` before `Start-Service sshd` |
| `cd` fails across drives in Windows cmd | Missing `/d` flag | Use `cmd /c "cd /d C:\..."` |
| Node not found / wrong version | Old Node in PATH | Prefix with `C:\Users\<user>\node22\node-v22.14.0-win-x64` or add to PATH |
| `authorized_keys` ignored on Windows | `.txt` extension added silently | Rename to remove `.txt` extension |
| install.mjs fails with "readline was closed" | Running non-interactively over SSH | The wrapper + hooks steps complete fine; the orchestrator step needs an interactive terminal |
