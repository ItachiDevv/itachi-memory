# Itachi Memory System — TODO

## Infrastructure
- [ ] Set up custom domain with SSL for Coolify (replace API URL)
- [ ] Add Hetzner Cloud Firewall (allow ports 22, 80, 443 only)
- [ ] Shut down old Railway deployment (`eliza-claude-production`)

## Post-Deploy
- [ ] Verify Telegram bot works after Railway shutdown
- [ ] Run `node install.mjs` on local machine to reinstall hooks with new API URL
- [ ] Test hooks end-to-end: edit a file, check session_edits table populates

## Phase 2: Absorb Orchestrator Setup into install.mjs — DONE
- [x] Add `--full` flag to install.mjs that includes orchestrator setup
- [x] Move orchestrator config (ID, workspace, machine dispatch) from setup.mjs into install.mjs
- [x] Move itachi CLI wrapper installation into install.mjs
- [x] Move `setEnvVars()` (setx on Windows, shell rc on Unix) into install.mjs
- [x] Move Claude/Codex auth sync (pushAuthCredentials/pullAuthCredentials) into install.mjs
- [x] Move Supabase credential bootstrap into install.mjs
- [x] Delete setup.mjs after all functionality absorbed
- [x] Update README to remove setup.mjs references

## Phase 3: curl One-Liner Distribution
- [ ] Publish to npm as `itachi-memory` package for `npx itachi-memory` support
- [ ] Host bootstrap.sh at a short URL for `curl | bash` one-liner
- [ ] Add `--version` and `--help` flags to install.mjs
- [ ] Add self-update mechanism (git pull + re-run install.mjs)
- [ ] Consider GitHub Releases with pre-built archives (no git clone needed)
