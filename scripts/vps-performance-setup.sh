#!/bin/bash
# VPS Performance Setup — run once on the Hetzner VPS to optimize for multi-agent workloads
# Usage: ssh root@100.84.73.84 'bash -s' < scripts/vps-performance-setup.sh
#   or:  /ssh hetzner bash -s < scripts/vps-performance-setup.sh
set -e

echo "=== VPS Performance Setup ==="
echo ""

# --- 1. Add 4GB swap (prevents OOM kills during multi-agent runs) ---
if swapon --show | grep -q '/swapfile'; then
  echo "[swap] Already configured:"
  swapon --show
else
  echo "[swap] Creating 4GB swap file..."
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile

  # Make permanent
  if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi

  # Tune swappiness — low value means only swap under pressure
  sysctl vm.swappiness=10
  echo 'vm.swappiness=10' >> /etc/sysctl.conf

  echo "[swap] Done. 4GB swap active:"
  swapon --show
fi
echo ""

# --- 2. Stop coolify-sentinel (frees CPU/memory, harmless to remove) ---
if docker ps --format '{{.Names}}' | grep -q 'coolify-sentinel'; then
  echo "[sentinel] Stopping coolify-sentinel to free resources..."
  docker stop coolify-sentinel
  # Prevent it from restarting on reboot
  docker update --restart=no coolify-sentinel
  echo "[sentinel] Stopped and disabled auto-restart."
else
  echo "[sentinel] coolify-sentinel already stopped or not present."
fi
echo ""

# --- 3. Show final resource status ---
echo "=== Current Resource Status ==="
echo ""
echo "--- Memory ---"
free -h
echo ""
echo "--- Swap ---"
swapon --show
echo ""
echo "--- Disk ---"
df -h /
echo ""
echo "--- Docker containers ---"
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | head -20
echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Redeploy Itachi bot to pick up new defaults (ITACHI_MAX_CONCURRENT=4, timeout=15min)"
echo "     Run: /deploy in Telegram, or push to master"
echo "  2. Monitor with: docker stats --no-stream"
