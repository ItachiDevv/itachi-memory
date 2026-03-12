#!/usr/bin/env node
// tools/install-watcher.mjs
// Cross-platform installer for session-watcher daemon
// Usage: node install-watcher.mjs [--uninstall]

import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, platform } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WATCHER_SCRIPT = join(__dirname, 'session-watcher.mjs');
const uninstall = process.argv.includes('--uninstall');

function findNode() {
  try { return execSync('which node || where node', { encoding: 'utf-8' }).trim().split('\n')[0]; }
  catch { return process.execPath; }
}

function installMac() {
  const plistName = 'com.itachi.session-watcher';
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${plistName}.plist`);

  if (uninstall) {
    try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`); } catch {}
    console.log(`Unloaded ${plistName}`);
    return;
  }

  const nodePath = findNode();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${plistName}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${WATCHER_SCRIPT}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${homedir()}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/session-watcher.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/session-watcher.err</string>
    <key>ThrottleInterval</key>
    <integer>30</integer>
</dict>
</plist>`;

  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist);
  try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`); } catch {}
  execSync(`launchctl load "${plistPath}"`);
  console.log(`Installed and started: ${plistPath}`);
}

function installLinux() {
  const serviceName = 'itachi-session-watcher';
  const servicePath = join(homedir(), '.config', 'systemd', 'user', `${serviceName}.service`);

  if (uninstall) {
    try { execSync(`systemctl --user stop ${serviceName} 2>/dev/null`); } catch {}
    try { execSync(`systemctl --user disable ${serviceName} 2>/dev/null`); } catch {}
    console.log(`Stopped and disabled ${serviceName}`);
    return;
  }

  const nodePath = findNode();
  const unit = `[Unit]
Description=Itachi Session Watcher
After=network.target

[Service]
ExecStart=${nodePath} ${WATCHER_SCRIPT}
Restart=always
RestartSec=30
Environment=HOME=${homedir()}

[Install]
WantedBy=default.target
`;

  mkdirSync(dirname(servicePath), { recursive: true });
  writeFileSync(servicePath, unit);
  execSync('systemctl --user daemon-reload');
  execSync(`systemctl --user enable ${serviceName}`);
  execSync(`systemctl --user start ${serviceName}`);
  console.log(`Installed and started: ${servicePath}`);
}

function installWindows() {
  const taskName = 'ItachiSessionWatcher';

  if (uninstall) {
    try { execSync(`schtasks /delete /tn "${taskName}" /f`, { stdio: 'pipe' }); } catch {}
    console.log(`Removed scheduled task: ${taskName}`);
    return;
  }

  const nodePath = findNode();
  // Create a wrapper .cmd that runs node with the watcher script
  const cmdPath = join(__dirname, 'session-watcher.cmd');
  writeFileSync(cmdPath, `@echo off\r\n"${nodePath}" "${WATCHER_SCRIPT}"\r\n`);

  // Create scheduled task that runs at logon and restarts on failure
  try {
    execSync(`schtasks /create /tn "${taskName}" /tr "\\"${cmdPath}\\"" /sc onlogon /rl highest /f`, { stdio: 'pipe' });
    // Start it now
    execSync(`schtasks /run /tn "${taskName}"`, { stdio: 'pipe' });
    console.log(`Installed scheduled task: ${taskName}`);
    console.log(`Wrapper: ${cmdPath}`);
  } catch (err) {
    console.error(`Failed to create task: ${err.message}`);
    console.log('\nManual alternative — run in PowerShell as admin:');
    console.log(`schtasks /create /tn "${taskName}" /tr "\\"${cmdPath}\\"" /sc onlogon /rl highest /f`);
  }
}

console.log(`Platform: ${platform()}`);
console.log(`Watcher: ${WATCHER_SCRIPT}`);
console.log(`Action: ${uninstall ? 'uninstall' : 'install'}\n`);

switch (platform()) {
  case 'darwin': installMac(); break;
  case 'linux': installLinux(); break;
  case 'win32': installWindows(); break;
  default: console.error(`Unsupported platform: ${platform()}`);
}
