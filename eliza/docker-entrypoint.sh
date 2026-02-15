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

exec "$@"
