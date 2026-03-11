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

## macOS Setup

### 1. Clone the repo

```bash
git clone https://github.com/ItachiDevv/itachi-memory.git ~/itachi-memory
cd ~/itachi-memory
```

### 2. Create the passphrase file

```bash
echo -n "itachidevv" > ~/.itachi-key
chmod 600 ~/.itachi-key
```

### 3. Create the API keys file

```bash
# Create/edit ~/.itachi-api-keys
# Add each key on its own line; quote values containing |
nano ~/.itachi-api-keys
```

### 4. Install hook symlinks

```bash
ln -sf /Users/yourname/itachi-memory/hooks/unix/session-start.sh ~/.claude/hooks/session-start.sh
ln -sf /Users/yourname/itachi-memory/hooks/unix/session-end.sh ~/.claude/hooks/session-end.sh
ln -sf /Users/yourname/itachi-memory/hooks/unix/user-prompt-submit.sh ~/.claude/hooks/user-prompt-submit.sh
ln -sf /Users/yourname/itachi-memory/hooks/unix/after-edit.sh ~/.claude/hooks/after-edit.sh
```

Or symlink the whole batch at once:

```bash
for f in /Users/yourname/itachi-memory/hooks/unix/*.sh; do
  ln -sf "$f" ~/.claude/hooks/"$(basename "$f")"
done
```

### 5. Create orchestrator .env

```bash
cp ~/itachi-memory/orchestrator/.env.example ~/itachi-memory/orchestrator/.env
# Edit the file and fill in SUPABASE_SERVICE_ROLE_KEY, ITACHI_MACHINE_ID, ITACHI_MACHINE_NAME, ITACHI_WORKSPACE_DIR
nano ~/itachi-memory/orchestrator/.env
```

### 6. Build the orchestrator

```bash
cd ~/itachi-memory/orchestrator
npm install
npm run build
```

### 7. Run the orchestrator

**Manual (for testing):**
```bash
node dist/index.js
```

**Auto-start via launchd (recommended for production):**

Create `~/Library/LaunchAgents/com.itachi.orchestrator.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.itachi.orchestrator</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/yourname/itachi-memory/orchestrator/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/yourname/itachi-memory/orchestrator</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/itachi-orchestrator.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/itachi-orchestrator.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.itachi.orchestrator.plist
```

---

## Windows Setup

> This section documents the real process including all pitfalls that were actually hit. Do not skip it — Windows has several non-obvious gotchas.

### 1. Node.js version

**PITFALL — pre-installed Node is too old**: Windows machines often have Node v8 pre-installed (from a previous install or company image). v8 will not work. You need Node 22+.

Download the **zip** from https://nodejs.org (not the installer — the zip is easier to manage without admin rights):

1. Download `node-v22.x.x-win-x64.zip` from nodejs.org
2. Extract to `C:\Users\<user>\node22\` — you should have a path like `C:\Users\<user>\node22\node-v22.14.0-win-x64\`
3. Add that directory to PATH, or prefix all `node` commands explicitly (see step 7 below)

### 2. Clone the repo

```powershell
git clone https://github.com/ItachiDevv/itachi-memory.git C:\Users\<user>\itachi-memory
```

### 3. Create the passphrase file

```powershell
"itachidevv" | Out-File -Encoding ascii -NoNewline "$env:USERPROFILE\.itachi-key"
```

### 4. Create the API keys file

Create `C:\Users\<user>\.itachi-api-keys`. Use a plain text editor (not Notepad if it adds a `.txt` extension). Format:

```
KEY1=value1
COOLIFY_API_KEY="6|abc123..."
```

Remember: quote any value containing `|`.

### 5. Install hook symlinks

In PowerShell (run as Administrator, or the symlinks will fail):

```powershell
$repo = "C:\Users\<user>\itachi-memory"
$hooksDir = "$env:USERPROFILE\.claude\hooks"
New-Item -ItemType Directory -Force $hooksDir

Get-ChildItem "$repo\hooks\windows\*.ps1" | ForEach-Object {
    New-Item -ItemType SymbolicLink -Path "$hooksDir\$($_.Name)" -Target $_.FullName -Force
}
```

### 6. SSH Server setup

**PITFALL — sshd starts as DISABLED**: The OpenSSH server on Windows defaults to `StartType=DISABLED`. You must set the start type before starting the service. Steps in this exact order:

```powershell
# 1. Install the capability (run as Administrator)
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# 2. Set start type BEFORE trying to start (this is the step people miss)
sc.exe config sshd start= auto

# 3. Now start the service
Start-Service sshd

# 4. Confirm it's set to automatic
Set-Service -Name sshd -StartupType 'Automatic'
```

**PITFALL — authorized_keys location for Administrator accounts**: If the user is in the `Administrators` group, SSH ignores `~\.ssh\authorized_keys`. The file must be at:

```
C:\ProgramData\ssh\administrators_authorized_keys
```

Set permissions so only SYSTEM and Administrators can read it:

```powershell
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "SYSTEM:(F)" /grant "BUILTIN\Administrators:(F)"
```

**PITFALL — .txt extension**: Windows may silently save `authorized_keys` as `authorized_keys.txt`. SSH will ignore it. Verify with:

```powershell
dir C:\ProgramData\ssh\
```

If you see `administrators_authorized_keys.txt`, rename it:

```powershell
Rename-Item "C:\ProgramData\ssh\administrators_authorized_keys.txt" "C:\ProgramData\ssh\administrators_authorized_keys"
```

### 7. Create orchestrator .env

Copy `.env.example` to `.env` in the orchestrator directory and fill in the required values.

### 8. Build the orchestrator

```powershell
$NODE = "C:\Users\<user>\node22\node-v22.14.0-win-x64"
cd C:\Users\<user>\itachi-memory\orchestrator
& "$NODE\npm.cmd" install
& "$NODE\npm.cmd" run build
```

### 9. Run the orchestrator

**PITFALL — `cd` across drives requires `/d` flag**: Regular `cmd /c "cd C:\..."` silently fails when switching drives. Always use `/d`:

```powershell
cmd /c "cd /d C:\Users\<user>\itachi-memory\orchestrator && set PATH=C:\Users\<user>\node22\node-v22.14.0-win-x64;%PATH% && node dist/index.js > orchestrator.log 2>&1"
```

For a scheduled task that runs on login:

```powershell
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument '/c "cd /d C:\Users\<user>\itachi-memory\orchestrator && set PATH=C:\Users\<user>\node22\node-v22.14.0-win-x64;%PATH% && node dist/index.js > C:\Users\<user>\orchestrator.log 2>&1"'
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "ItachiOrchestrator" -Action $action -Trigger $trigger -RunLevel Highest
```

---

## Linux / VPS Setup

This documents setup as done on the Hetzner VPS (Debian, running as root). Adjust paths for non-root users.

### 1. Install Node 22+

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version   # should be v22.x.x
```

### 2. Clone the repo

```bash
git clone https://github.com/ItachiDevv/itachi-memory.git ~/itachi-memory
cd ~/itachi-memory
```

### 3. Create config files

```bash
# Passphrase file
echo -n "itachidevv" > ~/.itachi-key
chmod 600 ~/.itachi-key

# API keys (quote values containing |)
nano ~/.itachi-api-keys
```

### 4. Install hook symlinks

```bash
mkdir -p ~/.claude/hooks
for f in ~/itachi-memory/hooks/unix/*.sh; do
  ln -sf "$f" ~/.claude/hooks/"$(basename "$f")"
done
```

### 5. Create orchestrator .env

```bash
cp ~/itachi-memory/orchestrator/.env.example ~/itachi-memory/orchestrator/.env
nano ~/itachi-memory/orchestrator/.env
```

Fill in `SUPABASE_SERVICE_ROLE_KEY`, `ITACHI_MACHINE_ID`, `ITACHI_MACHINE_NAME`, and `ITACHI_WORKSPACE_DIR`.

### 6. Build the orchestrator

```bash
cd ~/itachi-memory/orchestrator
npm install
npm run build
```

### 7. Run as a systemd service

Create `/etc/systemd/system/itachi-orchestrator.service`:

```ini
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
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable itachi-orchestrator
systemctl start itachi-orchestrator
```

Check status and logs:

```bash
systemctl status itachi-orchestrator
journalctl -u itachi-orchestrator -f
```

---

## Verifying a New Setup

After the orchestrator is running, confirm it's working:

1. **Check it connects to Supabase** — logs should say something like `Orchestrator started` and `Polling for tasks` with no auth errors.
2. **Send a test task via Telegram** — use `/task <project> <description>` and watch the logs.
3. **Check the correct Supabase project** — if the orchestrator polls but never claims, the machine is probably connecting to the wrong project. Re-check `SUPABASE_URL` in `.env`.
4. **Check dotenv override** — if env vars from `~/.itachi-api-keys` seem to override `.env`, the dotenv config must have `override: true`.

---

## Agent Wrapper (Optional but Recommended)

The `.agents/itachi/` directory contains wrappers that launch Claude (or other AI CLIs) with the full Itachi context loaded. See `.agents/itachi/global-install.md` for full documentation.

Quick install on Mac/Linux:

```bash
cd /path/to/itachi-memory/.agents/itachi
./install.sh claude   # creates ~/.claude/itachi wrapper
```

On Windows:

```powershell
cd \path\to\itachi-memory\.agents\itachi
.\install.ps1 claude
```

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Orchestrator polls but never claims tasks | Wrong Supabase project in `.env` | Check `SUPABASE_URL` — active project is `zhbchbslvwrgjbzakeap` |
| API key value is truncated | `\|` in value not quoted | Wrap value in double quotes in `~/.itachi-api-keys` |
| stale env vars override `.env` | dotenv not using `override: true` | Already fixed in code; check you didn't revert it |
| SSH not accepting keys (Windows, Admin user) | Keys in wrong file | Use `C:\ProgramData\ssh\administrators_authorized_keys`, not `~\.ssh\authorized_keys` |
| SSH service won't start on Windows | Start type was DISABLED | Run `sc.exe config sshd start= auto` before `Start-Service sshd` |
| `cd` fails across drives in Windows cmd | Missing `/d` flag | Use `cmd /c "cd /d C:\..."` |
| Node not found / wrong version | Old Node in PATH | Prefix path with `C:\Users\<user>\node22\node-v22.14.0-win-x64` |
| `authorized_keys` ignored | `.txt` extension added by Windows | Rename to remove `.txt` extension |
