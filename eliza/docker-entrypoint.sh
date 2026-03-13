#!/bin/sh
# ElizaOS Docker entrypoint
# Sets up SSH keys before starting the app

# Create .ssh dir
mkdir -p /root/.ssh
chmod 700 /root/.ssh

# Method 1: SSH key from base64-encoded env var (preferred — survives Coolify rebuilds)
if [ -n "$SSH_PRIVATE_KEY_B64" ]; then
  echo "$SSH_PRIVATE_KEY_B64" | base64 -d > /root/.ssh/id_ed25519
  chmod 600 /root/.ssh/id_ed25519
  echo "[entrypoint] SSH key loaded from SSH_PRIVATE_KEY_B64 env var"
# Method 2: SSH key from mounted volume (fallback)
elif [ -f /ssh-keys/elizaos_bot_key ]; then
  cp /ssh-keys/elizaos_bot_key /root/.ssh/id_ed25519
  chmod 600 /root/.ssh/id_ed25519
  echo "[entrypoint] SSH keys loaded from /ssh-keys volume"
fi

# Disable strict host key checking for Tailscale IPs (100.x.x.x)
cat > /root/.ssh/config << 'EOF'
Host 100.*
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
EOF
chmod 600 /root/.ssh/config

# Claude Code setup for itachi user (non-root so bypassPermissions works)
mkdir -p /home/itachi/.claude /home/itachi/.ssh
if [ -n "$CLAUDE_CREDENTIALS_B64" ]; then
  echo "$CLAUDE_CREDENTIALS_B64" | base64 -d > /home/itachi/.claude/.credentials.json
  chmod 600 /home/itachi/.claude/.credentials.json
  echo "[entrypoint] Claude Code credentials loaded for itachi user"
fi

# Copy SSH keys so itachi user can SSH to other machines
if [ -f /root/.ssh/id_ed25519 ]; then
  cp /root/.ssh/id_ed25519 /home/itachi/.ssh/id_ed25519
  cp /root/.ssh/config /home/itachi/.ssh/config
  chmod 700 /home/itachi/.ssh
  chmod 600 /home/itachi/.ssh/id_ed25519 /home/itachi/.ssh/config
fi

# Full permissions — container is Claude's home
cat > /home/itachi/.claude/settings.json << 'SETTINGS'
{
  "permissions": {
    "defaultMode": "bypassPermissions",
    "allow": [
      "Bash",
      "Read",
      "Edit",
      "Write",
      "WebFetch",
      "Grep",
      "Glob",
      "NotebookEdit"
    ]
  }
}
SETTINGS

chown -R itachi:itachi /home/itachi
echo "[entrypoint] Claude Code configured for itachi user"

exec "$@"
