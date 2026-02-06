# GitHub — Repos, PRs, Issues & Actions via CLI/API

Expert-level knowledge of GitHub for creating repos, managing PRs, issues, releases, and Actions workflows using the `gh` CLI and REST/GraphQL API. Use when creating repositories, managing pull requests, configuring GitHub Actions, or automating GitHub workflows.

## Authentication

```bash
# CLI login (interactive)
gh auth login

# Token-based (non-interactive)
export GITHUB_TOKEN="ghp_..."
# or
export GH_TOKEN="ghp_..."
# Token scopes needed: repo, workflow, read:org, delete_repo

# API header
Authorization: Bearer <GITHUB_TOKEN>
# or
Authorization: token <GITHUB_TOKEN>
```

## gh CLI Commands

### Repositories

```bash
# Create new repo
gh repo create my-app --public --description "My app"
gh repo create my-app --private --clone
gh repo create org/my-app --public --source=. --remote=origin --push

# Create from template
gh repo create my-app --template owner/template-repo

# Clone
gh repo clone owner/repo
gh repo clone owner/repo -- --depth 1

# Fork
gh repo fork owner/repo --clone

# View repo info
gh repo view owner/repo
gh repo view --web  # Open in browser

# List repos
gh repo list owner --limit 30
gh repo list owner --language typescript

# Delete repo
gh repo delete owner/repo --yes

# Archive repo
gh repo archive owner/repo

# Set topics
gh repo edit owner/repo --add-topic typescript --add-topic nextjs

# Set description
gh repo edit owner/repo --description "New description"

# Set default branch
gh repo edit owner/repo --default-branch main

# Set visibility
gh repo edit owner/repo --visibility public
```

### Pull Requests

```bash
# Create PR
gh pr create --title "Add feature" --body "Description"
gh pr create --base main --head feature-branch
gh pr create --fill          # Use commit messages
gh pr create --draft
gh pr create --reviewer user1,user2
gh pr create --label bug,urgent
gh pr create --assignee @me

# List PRs
gh pr list
gh pr list --state open --author @me
gh pr list --search "is:open label:bug"

# View PR
gh pr view 123
gh pr view 123 --json title,body,state,reviews

# Checkout PR locally
gh pr checkout 123

# Review PR
gh pr review 123 --approve
gh pr review 123 --request-changes --body "Please fix..."
gh pr review 123 --comment --body "Looks good"

# Merge PR
gh pr merge 123
gh pr merge 123 --squash --delete-branch
gh pr merge 123 --rebase
gh pr merge 123 --auto --squash  # Auto-merge when checks pass

# Close PR
gh pr close 123

# PR comments
gh pr comment 123 --body "Comment text"

# PR diff
gh pr diff 123

# PR checks status
gh pr checks 123
```

### Issues

```bash
# Create issue
gh issue create --title "Bug report" --body "Description"
gh issue create --label bug --assignee @me

# List issues
gh issue list
gh issue list --label bug --state open

# View issue
gh issue view 456

# Close issue
gh issue close 456

# Reopen
gh issue reopen 456

# Comment
gh issue comment 456 --body "Working on this"

# Edit
gh issue edit 456 --add-label priority-high
```

### Releases

```bash
# Create release
gh release create v1.0.0 --title "Version 1.0" --notes "Release notes"
gh release create v1.0.0 --generate-notes  # Auto-generate from PRs
gh release create v1.0.0 ./dist/*.zip       # Upload assets

# List releases
gh release list

# Download release assets
gh release download v1.0.0

# Delete release
gh release delete v1.0.0 --yes
```

### GitHub Actions

```bash
# List workflow runs
gh run list
gh run list --workflow=ci.yml

# View run details
gh run view 12345
gh run view 12345 --log

# Watch run (live)
gh run watch 12345

# Re-run failed
gh run rerun 12345
gh run rerun 12345 --failed

# Trigger workflow dispatch
gh workflow run ci.yml
gh workflow run ci.yml --ref main -f param1=value1

# List workflows
gh workflow list
gh workflow view ci.yml
```

### Secrets & Variables

```bash
# Set repo secret
gh secret set SECRET_NAME --body "value"
gh secret set SECRET_NAME < secret.txt

# Set org secret
gh secret set SECRET_NAME --org my-org --body "value"

# List secrets
gh secret list

# Set environment variable
gh variable set VAR_NAME --body "value"
gh variable list

# Delete
gh secret delete SECRET_NAME
gh variable delete VAR_NAME
```

### Gists

```bash
# Create gist
gh gist create file.txt --public
gh gist create file1.txt file2.txt --desc "My gist"

# List gists
gh gist list

# View
gh gist view <id>

# Edit
gh gist edit <id>
```

### API (direct)

```bash
# Generic API call (REST)
gh api repos/owner/repo
gh api repos/owner/repo/issues --method POST -f title="Bug" -f body="Desc"

# GraphQL
gh api graphql -f query='{ viewer { login } }'

# Paginated listing
gh api repos/owner/repo/issues --paginate

# JSON output + jq
gh api repos/owner/repo --jq '.default_branch'
```

## REST API Key Endpoints

Base URL: `https://api.github.com`

### Repositories

```bash
# Create repo
POST /user/repos
{ "name": "my-app", "private": false, "description": "..." }

# Create org repo
POST /orgs/{org}/repos
{ "name": "my-app", "private": true }

# Get repo
GET /repos/{owner}/{repo}

# Delete repo (requires delete_repo scope)
DELETE /repos/{owner}/{repo}

# List user repos
GET /users/{username}/repos?sort=updated&per_page=30

# Create from template
POST /repos/{template_owner}/{template_repo}/generate
{ "name": "new-repo", "owner": "org-name" }
```

### Contents (Files)

```bash
# Get file contents
GET /repos/{owner}/{repo}/contents/{path}

# Create or update file
PUT /repos/{owner}/{repo}/contents/{path}
{
  "message": "Add file",
  "content": "<base64-encoded>",
  "sha": "<existing-sha-for-update>"
}

# Delete file
DELETE /repos/{owner}/{repo}/contents/{path}
{ "message": "Delete file", "sha": "<sha>" }
```

### Pull Requests

```bash
# Create PR
POST /repos/{owner}/{repo}/pulls
{
  "title": "Feature",
  "head": "feature-branch",
  "base": "main",
  "body": "Description"
}

# List PRs
GET /repos/{owner}/{repo}/pulls?state=open

# Merge PR
PUT /repos/{owner}/{repo}/pulls/{number}/merge
{ "merge_method": "squash" }
```

## GitHub Actions Workflow Template

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build
      - run: npm test
```

## Programmatic Repo Creation Pattern

```bash
# Full workflow: create repo + push code + set up CI
export GITHUB_TOKEN="ghp_..."

# 1. Create repo
gh repo create my-org/my-app --public --description "New project"

# 2. Initialize local project
mkdir my-app && cd my-app
npm init -y
git init
git remote add origin https://github.com/my-org/my-app.git

# 3. Add CI workflow
mkdir -p .github/workflows
# ... write workflow file ...

# 4. Push
git add -A && git commit -m "Initial commit"
git push -u origin main

# 5. Set secrets for deployment
gh secret set VERCEL_TOKEN --body "$VERCEL_TOKEN"
gh secret set SUPABASE_URL --body "$SUPABASE_URL"

# 6. Enable branch protection
gh api repos/my-org/my-app/branches/main/protection \
  --method PUT \
  -f required_status_checks='{"strict":true,"contexts":["build"]}' \
  -f enforce_admins=false \
  -f required_pull_request_reviews='{"required_approving_review_count":1}'
```

## Env Vars Used

- `GITHUB_TOKEN` / `GH_TOKEN` — Personal access token (ghp_...)
- `GITHUB_ENTERPRISE_TOKEN` — For GitHub Enterprise Server
