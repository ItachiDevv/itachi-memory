# Mac Orchestrator Testing - TODO

## Status: Partially Complete (2026-02-10)

### What's Done
- [x] Clean install on Mac (`/Users/itachisan/itachi/itachi-memory/`) - fresh clone, built
- [x] Orchestrator `.env` configured (itachi-m1, opus, no stale GITHUB_TOKEN)
- [x] gh CLI authenticated as ItachiDevv on Mac
- [x] gh credential helper configured for git (`gh auth setup-git`)
- [x] Mac registered in ElizaOS as `itachi-m1` (darwin, 2 max concurrent)
- [x] Task 5f257e2c dispatched to Mac and completed ($0.12, 1 file changed)
- [x] Telegram notification received in General topic
- [x] Task classifier works (fell back to medium due to API timeout)

### What's Remaining
- [ ] **Git push / PR creation** - failed with "could not read Username for https://github.com: Device not configured"
  - `gh auth setup-git` was run but needs testing with a new task
  - May need to restart orchestrator for the credential helper to take effect
- [ ] **SSH key auth from Windows to Mac** - NOT working
  - macOS sandbox blocks sshd from reading `~/.ssh/authorized_keys`
  - Tried: Full Disk Access for `/usr/sbin/sshd`, ACL removal, permissions fix
  - Still gets `Permission denied (publickey)`
  - **Workaround**: run commands directly on Mac Terminal
- [ ] **Test with PR creation** - send another task and verify full pipeline including PR
- [ ] **Test task classifier** - first task had ETIMEDOUT on Anthropic API (network issue?)
- [ ] **Multi-machine dispatch** - test that dispatcher correctly routes tasks to Mac vs Windows based on project affinity

### To Resume Testing
1. On Mac Terminal, restart orchestrator:
   ```bash
   pkill -f 'node.*orchestrator/dist' 2>/dev/null
   export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && export PATH="/usr/local/bin:$PATH"
   cd ~/itachi/itachi-memory/orchestrator && nohup node dist/index.js > /tmp/orchestrator.log 2>&1 &
   sleep 3 && tail -15 /tmp/orchestrator.log
   ```
2. Send test task via Telegram: `/task itachi-memory <description>`
3. Monitor Mac logs: `tail -f /tmp/orchestrator.log`
4. Check PR creation in GitHub

### Mac Access
- IP: `192.168.1.119`, User: `itachisan`
- SSH config entry exists in `~/.ssh/config` as `mac` (but needs password)
- Node: v24.13.0 via nvm (`~/.nvm/versions/node/v24.13.0/bin/`)
- Claude CLI: same nvm bin path
- gh: `/usr/local/bin/gh`
- Repo: `/Users/itachisan/itachi/itachi-memory/`
- Workspaces: `/Users/itachisan/itachi-workspaces/`
- Orchestrator logs: `/tmp/orchestrator.log`

### Windows Orchestrator (for reference)
- Running in background task `be21a2d`
- All tests passed: task creation, execution, PR creation, notifications
- Commits pushed: f580324, 239a355, a24927f, 45bd2c4, cf86826, d7342db
