# Vercel — Deploy & Manage Projects

Expert-level knowledge of the Vercel platform for deploying web applications, managing projects, domains, environment variables, and storage. Use when deploying to Vercel, creating projects, managing deployments, configuring domains, or using the Vercel REST API.

## Authentication

```bash
# CLI auth (interactive)
vercel login

# Token-based (non-interactive, for CI/orchestration)
export VERCEL_TOKEN="your-token"
# All CLI commands auto-use VERCEL_TOKEN when set
# Get tokens: vercel.com/account/tokens

# REST API header
Authorization: Bearer <VERCEL_TOKEN>
```

## CLI Commands Reference

### Project Lifecycle

```bash
# Deploy (auto-detects framework)
vercel                              # Preview deployment
vercel --prod                       # Production deployment
vercel --yes                        # Skip confirmation prompts

# Link local dir to Vercel project
vercel link
vercel link --yes                   # Auto-confirm

# Create new project
vercel project add <name>

# List projects
vercel project ls

# Remove project
vercel project rm <name>

# Pull env vars + project settings locally
vercel pull
vercel pull --environment production
```

### Environment Variables

```bash
# Add env var (interactive)
vercel env add VARIABLE_NAME

# Add env var non-interactively
echo "value" | vercel env add VARIABLE_NAME production
echo "value" | vercel env add VARIABLE_NAME preview
echo "value" | vercel env add VARIABLE_NAME development

# List env vars
vercel env ls

# Remove env var
vercel env rm VARIABLE_NAME production

# Pull .env.local from Vercel
vercel env pull .env.local
```

### Domains

```bash
# Add domain to project
vercel domains add example.com

# List domains
vercel domains ls

# Remove domain
vercel domains rm example.com

# Inspect domain config
vercel domains inspect example.com
```

### Development

```bash
# Local dev server (mirrors Vercel environment)
vercel dev
vercel dev --listen 0.0.0.0:3000

# Build locally (same as Vercel build)
vercel build
```

### Deployments

```bash
# List deployments
vercel ls
vercel ls --limit 20

# Inspect a deployment
vercel inspect <url-or-deployment-id>

# Promote preview to production
vercel promote <deployment-url>

# Rollback to previous production
vercel rollback

# Remove a deployment
vercel rm <deployment-url>

# View deployment logs
vercel logs <deployment-url>
vercel logs <deployment-url> --follow
```

### Teams

```bash
# Switch team scope
vercel --scope <team-slug>
vercel switch

# List teams
vercel teams ls
```

## REST API (v9+)

Base URL: `https://api.vercel.com`

### Projects

```bash
# Create project
POST /v10/projects
{
  "name": "my-project",
  "framework": "nextjs",
  "gitRepository": {
    "type": "github",
    "repo": "owner/repo"
  }
}

# List projects
GET /v9/projects?limit=20

# Get project
GET /v9/projects/{idOrName}

# Delete project
DELETE /v9/projects/{idOrName}

# Update project
PATCH /v9/projects/{idOrName}
{ "framework": "nextjs", "buildCommand": "npm run build" }
```

### Deployments

```bash
# Create deployment (file upload)
POST /v13/deployments
{
  "name": "my-project",
  "files": [...],
  "target": "production"
}

# List deployments
GET /v6/deployments?projectId={id}&limit=10

# Get deployment
GET /v13/deployments/{id}

# Cancel deployment
PATCH /v12/deployments/{id}/cancel

# Delete deployment
DELETE /v13/deployments/{id}
```

### Environment Variables

```bash
# Create env var
POST /v10/projects/{idOrName}/env
{
  "key": "DATABASE_URL",
  "value": "postgres://...",
  "target": ["production", "preview"],
  "type": "encrypted"
}

# List env vars
GET /v9/projects/{idOrName}/env

# Delete env var
DELETE /v9/projects/{idOrName}/env/{envId}

# Edit env var
PATCH /v9/projects/{idOrName}/env/{envId}
{ "value": "new-value" }
```

### Domains

```bash
# Add domain
POST /v10/projects/{idOrName}/domains
{ "name": "example.com" }

# List project domains
GET /v9/projects/{idOrName}/domains

# Remove domain
DELETE /v9/projects/{idOrName}/domains/{domain}

# Check domain availability
GET /v4/domains/status?name=example.com
```

## Framework Detection

Vercel auto-detects and configures:
- **Next.js**: `next build` / `next start` (default)
- **Vite**: `vite build`
- **Remix**: `remix build`
- **SvelteKit**: `svelte-kit build`
- **Nuxt**: `nuxt build`
- **Astro**: `astro build`
- **Create React App**: `react-scripts build`
- **Static HTML**: Serves as-is

Override with `vercel.json`:
```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "installCommand": "npm install",
  "framework": "vite"
}
```

## Serverless & Edge Functions

```
api/
  hello.ts       → GET/POST /api/hello
  users/[id].ts  → GET /api/users/:id
```

```typescript
// api/hello.ts — Serverless Function (Node.js)
export default function handler(req, res) {
  res.json({ message: 'Hello' });
}

// api/edge.ts — Edge Function
export const config = { runtime: 'edge' };
export default function handler(req: Request) {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

## Storage

### Vercel KV (Redis)
```typescript
import { kv } from '@vercel/kv';
await kv.set('key', 'value');
const val = await kv.get('key');
```

### Vercel Postgres
```typescript
import { sql } from '@vercel/postgres';
const { rows } = await sql`SELECT * FROM users WHERE id = ${id}`;
```

### Vercel Blob
```typescript
import { put, del, list } from '@vercel/blob';
const blob = await put('file.txt', 'content', { access: 'public' });
```

## vercel.json Configuration

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": ".next",
  "framework": "nextjs",
  "regions": ["iad1"],
  "rewrites": [
    { "source": "/api/:path*", "destination": "/api/:path*" }
  ],
  "redirects": [
    { "source": "/old", "destination": "/new", "permanent": true }
  ],
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [{ "key": "Access-Control-Allow-Origin", "value": "*" }]
    }
  ],
  "crons": [
    { "path": "/api/cron", "schedule": "0 5 * * *" }
  ]
}
```

## GitHub Integration

```bash
# Connect repo during project creation
vercel link --repo=owner/repo

# Auto-deploy: Push to GitHub → Vercel auto-deploys
# - Push to main → Production deployment
# - Push to PR branch → Preview deployment
# - Preview URL auto-commented on PR
```

## Programmatic Deploy Pattern

```bash
# Full workflow: create project + deploy
VERCEL_TOKEN="..." # required

# 1. Create project linked to GitHub repo
curl -X POST "https://api.vercel.com/v10/projects" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app","framework":"nextjs","gitRepository":{"type":"github","repo":"owner/repo"}}'

# 2. Set env vars
curl -X POST "https://api.vercel.com/v10/projects/my-app/env" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key":"DATABASE_URL","value":"postgres://...","target":["production"],"type":"encrypted"}'

# 3. Trigger deployment
curl -X POST "https://api.vercel.com/v13/deployments" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app","gitSource":{"type":"github","ref":"main","repoId":"..."}}'
```

## Common Patterns

### Monorepo
```json
{
  "buildCommand": "cd packages/web && npm run build",
  "outputDirectory": "packages/web/dist",
  "installCommand": "npm install --workspace=packages/web"
}
```

### Environment Variable per Branch
- `production` → deployed on `main` pushes
- `preview` → deployed on PR branches
- `development` → `vercel dev` only

### Cron Jobs
```json
{ "crons": [{ "path": "/api/daily-job", "schedule": "0 3 * * *" }] }
```

## Env Vars Used
- `VERCEL_TOKEN` — API + CLI auth token
- `VERCEL_ORG_ID` — Team/org ID (set by `vercel link`)
- `VERCEL_PROJECT_ID` — Project ID (set by `vercel link`)
