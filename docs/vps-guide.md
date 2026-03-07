# Hetzner VPS — What It Is & What You Can Do With It

## Actual Specs (as of March 2026)

| Resource | Total | Used | Free |
|----------|-------|------|------|
| **RAM** | 7.6 GB | ~1.6 GB (Coolify + Itachi) | **~6 GB available** |
| **Disk** | 75 GB | 12 GB (16%) | **61 GB free** |
| **CPU** | 2-4 vCPUs (Hetzner shared) | Load avg: 0.22 | Very low usage |
| **Uptime** | 29+ days continuous | — | Stable |
| **OS** | Debian (Linux) | — | — |

### What's Using Resources

| Container | Purpose | Part of your app? |
|-----------|---------|-------------------|
| `swoo0o4...` | **Itachi bot** (ElizaOS + Orchestrator) | Yes — your only app |
| `coolify` | Coolify management platform | Infrastructure |
| `coolify-proxy` (traefik) | Reverse proxy, SSL/HTTPS | Infrastructure |
| `coolify-db` (postgres) | Coolify's internal config DB | Infrastructure |
| `coolify-redis` | Coolify's cache | Infrastructure |
| `coolify-realtime` | Coolify's live log streaming | Infrastructure |
| `coolify-sentinel` | Health monitoring agent | Infrastructure |

Only 1 real app container. The rest is Coolify's own infrastructure.

---

## What You Have

A **Hetzner cloud VPS** — a virtual private server running Linux (Debian-based) in one of Hetzner's data centers. It's a full Linux machine in the cloud that's always on, always connected, and accessible from anywhere.

- **Domain**: `itachisbrainserver.online`
- **Management**: Coolify (self-hosted PaaS — like a personal Heroku/Vercel)
- **Container runtime**: Docker
- **Networking**: Tailscale VPN (IP: `100.84.73.84`) + public internet
- **Always-on**: 24/7 uptime — it doesn't sleep when you close your laptop

---

## Using the VPS as Remote Compute (Code Locally, Run Remotely)

When your local machine is weak or unavailable, you can write code on any device and offload the heavy compute to the VPS. Here are your options, from simplest to most powerful:

### Option 1: Telegram Task Dispatch (Already Working)

You already have this. Send tasks from any device with Telegram:

```
/task itachi-memory fix the login validation bug in auth.ts
/task itachi-memory add unit tests for the memory search service
/session hetzner investigate why builds are slow
```

- Tasks get queued → orchestrator on VPS claims them → Claude Code runs on VPS
- You get live output streamed back to Telegram
- Current config: `ITACHI_MAX_CONCURRENT=2` (can bump to 3-4)

**To increase concurrency for your 2-day window**, update the env var in Coolify:
1. Go to `https://coolify.itachisbrainserver.online`
2. Find the Itachi app → Environment Variables
3. Set `ITACHI_MAX_CONCURRENT=4`
4. Redeploy (or `/deploy` in Telegram)

### Option 2: SSH + Claude Code CLI Directly

SSH into the VPS and run Claude Code interactively, just like you would locally:

```bash
# Connect
ssh root@100.84.73.84

# Navigate to your project
cd /root/itachi-workspaces/itachi-memory

# Run Claude Code directly
claude

# Or run with skip permissions for faster iteration
claude --dangerously-skip-permissions
```

This gives you a full interactive Claude Code session running on VPS compute. Your weak machine just handles the SSH terminal — all the heavy lifting happens on the server.

**Multiple sessions**: Open multiple SSH terminals = multiple parallel Claude sessions.

### Option 3: Code Server (VS Code in Browser) — Recommended Setup

Deploy **Code Server** on Coolify to get VS Code accessible from any browser, running on VPS compute:

1. In Coolify dashboard → **New Resource** → **Docker Image**
2. Image: `codercom/code-server:latest`
3. Set env var: `PASSWORD=your-secure-password`
4. Expose port 8080, assign a subdomain like `code.itachisbrainserver.online`
5. Coolify handles SSL automatically

Now you can open `https://code.itachisbrainserver.online` from **any device** (even a phone/tablet) and get a full VS Code editor running on VPS compute. Extensions, terminal, git — everything works.

**Pair it with Claude Code**: Open the integrated terminal in Code Server and run `claude` — you get AI-assisted coding with VPS compute, all through a browser.

### Option 4: VS Code Remote SSH (Best Desktop Experience)

If you have VS Code installed on your weak machine (it's lightweight):

1. Install the **Remote - SSH** extension
2. Add SSH host: `root@100.84.73.84`
3. Connect → VS Code opens with full access to VPS filesystem
4. All extensions, builds, and terminals run on the VPS
5. Your local machine just renders the UI

This is the smoothest experience — feels exactly like local development but all compute happens on the server.

### Option 5: GitHub Codespaces / Claude Code on Web

If you have a Claude Pro/Team subscription, you can use **Claude Code on the web** (claude.ai) which runs in Anthropic's cloud — no VPS needed. But this doesn't have access to your VPS services directly.

---

## Performance Enhancements for Running Multiple Agents

### Increase Orchestrator Concurrency

Edit in Coolify environment variables:
```
ITACHI_MAX_CONCURRENT=4          # Up from default 2
ITACHI_TASK_TIMEOUT_MS=900000    # 15 min timeout (up from 10) for complex tasks
```

### Swap Space (Prevents OOM Kills)

If running 4 agents maxes out RAM, add swap space as a safety net. SSH in and run:
```bash
# Create 4GB swap file
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile

# Make permanent across reboots
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

This gives the OS a 4GB buffer before it starts killing processes. Swap is slower than RAM but prevents crashes.

### Reduce Coolify Overhead

The sentinel errors you see (`context deadline exceeded`) are harmless but waste cycles. You can stop the sentinel:
```bash
docker stop coolify-sentinel
```

This frees a small amount of CPU/memory. The bot works fine without it — you just lose resource graphs in the Coolify dashboard.

### Monitor During Heavy Use

Keep an eye on resources while running multiple agents:
```bash
# Quick check via Telegram
/ssh hetzner free -h && docker stats --no-stream

# Or via SSH
htop                    # Interactive process viewer
docker stats            # Live container resource usage
watch -n 5 free -h      # RAM every 5 seconds
```

### Upgrade Path (If Needed)

If 7.6 GB RAM isn't enough for 4 concurrent agents:
- Hetzner lets you **resize instantly** from the Cloud Console
- Going to 16 GB RAM would be very comfortable for 4+ agents
- You can resize up for the 2 days and resize back down after

---

## What Else Can You Do With a VPS?

A VPS is essentially **your own Linux computer in the cloud**. Beyond the Telegram bot, here's what's possible:

### 1. Host Websites & Web Apps
- Deploy any website (static or dynamic) — React, Next.js, Vue, plain HTML
- Coolify already gives you a nice UI for deploying multiple apps with automatic SSL (HTTPS)
- Point additional domains/subdomains to it
- Example: host a personal portfolio, a dashboard for Itachi's stats, or a web UI for the memory system

### 2. Run Additional Bots & Services
- Discord bots, Slack bots, or any other chat integrations
- Cron jobs / scheduled scripts (e.g., scrape data, send digest emails, auto-post content)
- Background workers that process data continuously
- Webhook receivers for GitHub, Stripe, or any service

### 3. Host APIs & Backends
- Build REST or GraphQL APIs for your own apps
- Proxy or aggregate external APIs
- Run a personal API gateway
- Host microservices that your other projects call

### 4. Run Databases
- You already use Supabase (hosted externally), but you could also run databases directly on the VPS:
  - PostgreSQL, MySQL, Redis, MongoDB, SQLite
  - Coolify makes this easy — it has one-click database deployments

### 5. Self-Host Tools & Services
Coolify's main superpower is one-click self-hosting. Some popular options:
- **n8n / Activepieces** — Visual workflow automation (like Zapier but self-hosted)
- **Uptime Kuma** — Monitor your services and get alerts when they go down
- **Plausible / Umami** — Privacy-friendly web analytics
- **Gitea / Forgejo** — Self-hosted Git (like a personal GitHub)
- **Minio** — S3-compatible object storage
- **Grafana + Prometheus** — Monitoring dashboards for your services
- **Portainer** — Docker container management UI
- **Vaultwarden** — Self-hosted Bitwarden password manager
- **Actual Budget** — Personal finance tracking
- **Ollama** — Run local LLMs (if VPS has enough RAM)
- **Code Server** — VS Code in the browser, accessible from anywhere

### 6. Development & Testing
- SSH into it and use it as a remote development machine
- Test deployments before going to production
- Run CI/CD pipelines
- Spin up temporary environments for testing
- Run long-running builds or computations that would be slow on your laptop

### 7. VPN & Networking
- You already have Tailscale — all your machines (Windows PC, Mac, VPS) are on the same private network
- Could run a reverse proxy (Caddy/Nginx) to expose local services
- Could run a WireGuard VPN server for general-purpose VPN access
- Tunnel traffic through it for privacy

### 8. File Storage & Sync
- Host a personal file server (Nextcloud, Seafile)
- Use it as a backup destination
- Share files publicly via simple HTTP
- Sync files between your machines (you already do encrypted sync via itachi-sync)

### 9. Game Servers
- Minecraft, Terraria, Valheim, or other game servers
- Depends on VPS specs (CPU/RAM)

### 10. Learning & Experimentation
- Practice Linux system administration
- Learn Docker, networking, reverse proxies, firewalls
- Experiment with new tech stacks without affecting your local machines
- Set up monitoring to learn observability (Grafana, Loki, Prometheus)

---

## How to Access & Manage It

### Via Coolify (Web UI)
- URL: `https://coolify.itachisbrainserver.online`
- Deploy new services, view logs, manage environment variables, check resource usage
- One-click deployments from GitHub repos or Docker images

### Via SSH
```bash
# Through Tailscale (private network)
ssh root@100.84.73.84

# Or if you have direct SSH configured
ssh root@itachisbrainserver.online
```

### Via Telegram (through Itachi)
```
/ssh hetzner ls -la /data
/ssh hetzner docker ps
/logs 50
/containers
/deploy
/restart-bot
```

### Via Docker (once SSH'd in)
```bash
docker ps                          # List running containers
docker logs <container> --tail 50  # View logs
docker exec -it <container> bash   # Shell into a container
```

---

## Quick Reference

| What | How |
|------|-----|
| Deploy the Itachi bot | Push to `master` or `/deploy` in Telegram |
| Deploy a new service | Coolify web UI → New Resource → pick source |
| Check what's running | `docker ps` via SSH, or Coolify dashboard |
| View logs | `/logs 50` in Telegram, or Coolify → Logs |
| Add a domain | Hetzner DNS panel + Coolify service config |
| Monitor health | `curl https://itachisbrainserver.online/health` |
| SSH into VPS | `ssh root@100.84.73.84` (via Tailscale) |
| Run Claude Code remotely | SSH in → `claude` in terminal |
| VS Code remote | VS Code → Remote SSH → `root@100.84.73.84` |
| Code in browser | Deploy Code Server via Coolify |
| Increase agent concurrency | Coolify → env → `ITACHI_MAX_CONCURRENT=4` |
| Add swap (safety net) | `fallocate -l 4G /swapfile && mkswap && swapon` |
| Upgrade VPS | Hetzner Cloud Console → Resize server |
