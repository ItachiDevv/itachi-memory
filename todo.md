# Itachi Memory System — TODO

## Infrastructure
- [ ] Set up custom domain with SSL for Coolify (replace sslip.io URL)
- [ ] Add Hetzner Cloud Firewall (allow ports 22, 80, 443 only)
- [ ] Shut down old Railway deployment (`eliza-claude-production`)

## Post-Deploy
- [ ] Verify Telegram bot works after Railway shutdown
- [ ] Run setup.ps1 on local machine to reinstall hooks with new API URL
- [ ] Test hooks end-to-end: edit a file, check session_edits table populates
