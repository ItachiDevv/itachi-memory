# Hetzner VPS — What It Is & What You Can Do With It

## What You Have

You have a **Hetzner cloud VPS** — a virtual private server running Linux (Debian-based) in one of Hetzner's data centers. It's a full Linux machine in the cloud that's always on, always connected, and accessible from anywhere.

- **Domain**: `itachisbrainserver.online`
- **Management**: Coolify (self-hosted PaaS — like a personal Heroku/Vercel)
- **Container runtime**: Docker
- **Networking**: Tailscale VPN (IP: `100.84.73.84`) + public internet
- **Always-on**: 24/7 uptime — it doesn't sleep when you close your laptop

## What's Currently Running On It

Right now the VPS runs a single Docker container with two services:

1. **ElizaOS** (port 3000) — The Itachi AI agent (Telegram bot, REST API, memory system, task queue, all the plugins)
2. **Orchestrator** (port 3001) — Task runner that spawns Claude Code CLI sessions inside the container

This is deployed via Coolify, which auto-redeploys when you push to `master` (or daily at 9 AM UTC via GitHub Actions).

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
- Depends on VPS specs (CPU/RAM) — check your Hetzner plan

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

## Resource Awareness

Keep in mind your VPS has **finite resources** (CPU, RAM, disk). Check your Hetzner plan to know your limits. Tips:
- Use `htop` or `docker stats` to monitor resource usage
- Don't run too many heavy services simultaneously
- Coolify shows resource usage in its dashboard
- If you need more power, Hetzner makes it easy to upgrade your plan

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
