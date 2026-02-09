#!/usr/bin/env node
// Itachi Memory System — Unified Installer v2
// One script, all platforms, built-in modules only.
//
// Usage:
//   node install.mjs                    # Install hooks, skills, MCP, settings
//   node install.mjs --update           # git pull + re-install
//   node install.mjs --full             # Full setup: + auth sync, orchestrator, CLI wrapper
//   node install.mjs --api-url <url>    # Override API URL
//   node install.mjs --no-cron          # Skip scheduled task registration
//
import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { createHash, pbkdf2Sync, createDecipheriv, randomBytes, createCipheriv } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, readdirSync, unlinkSync, renameSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir, hostname, platform as osPlatform } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Config ──────────────────────────────────────────────
const PLATFORM = osPlatform() === 'win32' ? 'windows' : osPlatform() === 'darwin' ? 'macos' : 'linux';
const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const HOOKS_DIR = join(CLAUDE_DIR, 'hooks');
const SKILLS_DIR = join(CLAUDE_DIR, 'skills');
const API_KEYS_FILE = join(HOME, '.itachi-api-keys');
const ITACHI_KEY_FILE = join(HOME, '.itachi-key');

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { apiUrl: 'https://itachisbrainserver.online', noCron: false, full: false, update: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--api-url' && args[i + 1]) opts.apiUrl = args[++i];
    if (args[i] === '--no-cron') opts.noCron = true;
    if (args[i] === '--full') opts.full = true;
    if (args[i] === '--update' || args[i] === '-u') opts.update = true;
  }
  if (process.env.ITACHI_API_URL) opts.apiUrl = process.env.ITACHI_API_URL;
  return opts;
}

const OPTS = parseArgs();
const API_URL = OPTS.apiUrl;

// All supported credentials
const CREDENTIALS = [
  { key: 'ITACHI_API_KEY',        label: 'Itachi API Key',               hint: 'Required for all hooks' },
  { key: 'GITHUB_TOKEN',          label: 'GitHub Token',                 hint: 'ghp_... (repo, workflow)' },
  { key: 'VERCEL_TOKEN',          label: 'Vercel Token',                 hint: 'from vercel.com/account/tokens' },
  { key: 'SUPABASE_ACCESS_TOKEN', label: 'Supabase Access Token',        hint: 'from supabase.com dashboard' },
  { key: 'OPENAI_API_KEY',        label: 'OpenAI API Key',               hint: 'sk-... (optional, embeddings)' },
  { key: 'GEMINI_API_KEY',        label: 'Google Gemini API Key',        hint: 'from aistudio.google.com' },
  { key: 'X_API_KEY',             label: 'X (Twitter) API Key',          hint: 'from developer.x.com' },
  { key: 'X_API_SECRET',          label: 'X API Secret',                 hint: '' },
  { key: 'X_ACCESS_TOKEN',        label: 'X Access Token',               hint: '' },
  { key: 'X_ACCESS_TOKEN_SECRET', label: 'X Access Token Secret',        hint: '' },
  { key: 'X_BEARER_TOKEN',        label: 'X Bearer Token',               hint: '' },
];

const MACHINE_KEYS = ['ITACHI_ORCHESTRATOR_ID', 'ITACHI_WORKSPACE_DIR', 'ITACHI_PROJECT_PATHS', 'ITACHI_MACHINE_ID', 'ITACHI_MACHINE_NAME'];

const ALL_SKILLS = [
  'itachi-init', 'itachi-env', 'github', 'vercel', 'supabase', 'x-api',
  'elizaos', 'google-gemini', 'polymarket-api', 'tamagotchi-sprites',
  'threejs-animation', 'threejs-fundamentals', 'threejs-geometry', 'threejs-interaction',
  'threejs-lighting', 'threejs-loaders', 'threejs-materials', 'threejs-postprocessing',
  'threejs-shaders', 'threejs-textures',
];

let API_KEY = '';

// ── Helpers ─────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt) => new Promise(r => rl.question(prompt, r));

function askSecret(prompt) {
  return new Promise(r => {
    process.stdout.write(prompt);
    if (PLATFORM === 'windows') {
      try {
        const val = execSync(
          'powershell -Command "[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host -AsSecureString)))"',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        console.log('');
        r(val);
      } catch { r(''); }
    } else {
      const old = process.stdin.isRaw;
      if (process.stdin.setRawMode) process.stdin.setRawMode(true);
      let buf = '';
      const onData = (ch) => {
        const c = ch.toString();
        if (c === '\n' || c === '\r') {
          if (process.stdin.setRawMode) process.stdin.setRawMode(old);
          process.stdin.removeListener('data', onData);
          console.log('');
          r(buf);
        } else if (c === '\x7f' || c === '\b') {
          buf = buf.slice(0, -1);
        } else if (c === '\x03') {
          process.exit(1);
        } else {
          buf += c;
        }
      };
      process.stdin.on('data', onData);
      process.stdin.resume();
    }
  });
}

const C = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m', reset: '\x1b[0m', bold: '\x1b[1m' };
const log = (msg, color = '') => console.log(`${C[color] || ''}${msg}${color ? C.reset : ''}`);

function commandExists(cmd) {
  try {
    if (PLATFORM === 'windows') execSync(`where ${cmd}`, { stdio: 'pipe' });
    else execSync(`command -v ${cmd}`, { stdio: 'pipe', shell: '/bin/sh' });
    return true;
  } catch { return false; }
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadApiKeys() {
  const kv = {};
  if (existsSync(API_KEYS_FILE)) {
    for (const line of readFileSync(API_KEYS_FILE, 'utf8').split('\n')) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
      if (m) kv[m[1]] = m[2];
    }
  }
  return kv;
}

function saveApiKeys(kv) {
  const sorted = Object.entries(kv).sort(([a], [b]) => a.localeCompare(b));
  writeFileSync(API_KEYS_FILE, sorted.map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  if (PLATFORM !== 'windows') { try { chmodSync(API_KEYS_FILE, 0o600); } catch {} }
}

// ── HTTP (fetch primary, https fallback) ────────────────
async function httpGet(url) {
  const headers = {};
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  // Strategy 1: fetch (Node 18+)
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    if (res.ok) { try { return JSON.parse(text); } catch { return text; } }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  } catch (e) {
    if (e.message?.startsWith('HTTP ')) throw e;
  }

  // Strategy 2: https module
  const https = await import('https');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, port: 443, path: u.pathname + u.search, headers: { ...headers, Accept: 'application/json' } }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch { resolve(body); }
        } else reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function httpPost(url, postBody) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  const bodyStr = JSON.stringify(postBody);

  try {
    const res = await fetch(url, { method: 'POST', headers, body: bodyStr, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (res.ok) { try { return JSON.parse(text); } catch { return text; } }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  } catch (e) {
    if (e.message?.startsWith('HTTP ')) throw e;
  }

  const https = await import('https');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) } }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch { resolve(body); }
        } else reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

// ── Crypto ──────────────────────────────────────────────
function decrypt(encB64, saltB64, passphrase) {
  const packed = Buffer.from(encB64, 'base64');
  const salt = Buffer.from(saltB64, 'base64');
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ct = packed.subarray(28);
  const key = pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct, null, 'utf8') + decipher.final('utf8');
}

function encrypt(content, passphrase) {
  const salt = randomBytes(16);
  const key = pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
  const packed = Buffer.concat([iv, cipher.getAuthTag(), ct]);
  return { encrypted_data: packed.toString('base64'), salt: salt.toString('base64'), content_hash: createHash('sha256').update(content).digest('hex') };
}

// ── Steps ───────────────────────────────────────────────

function step1_detectPlatform() {
  const nodeVer = process.version;
  const gitOk = commandExists('git');
  const claudeOk = commandExists('claude');

  log(`\n  ${C.bold}Itachi Memory System — Installer v2${C.reset}`);
  log(`  Platform: ${PLATFORM} | Node: ${nodeVer} | Git: ${gitOk ? 'OK' : 'MISSING'} | Claude: ${claudeOk ? 'OK' : 'MISSING'}`, 'gray');
  log('');

  if (!gitOk) {
    log('  Git is required. Install it first:', 'red');
    if (PLATFORM === 'windows') log('    winget install Git.Git');
    else if (PLATFORM === 'macos') log('    brew install git');
    else log('    sudo apt-get install -y git');
    process.exit(1);
  }

  if (!claudeOk) {
    log('  Claude Code CLI is required. Install it first:', 'red');
    log('    npm install -g @anthropic-ai/claude-code');
    process.exit(1);
  }
}

async function step2_loadOrCreatePassphrase() {
  if (existsSync(ITACHI_KEY_FILE)) {
    const passphrase = readFileSync(ITACHI_KEY_FILE, 'utf8').trim();
    log(`  Found passphrase at ${ITACHI_KEY_FILE}`, 'gray');
    return passphrase;
  }

  log('  Enter sync passphrase (same on all machines):', 'yellow');
  const passphrase = await askSecret('  Passphrase: ');
  if (!passphrase) {
    log('  ERROR: Passphrase cannot be empty.', 'red');
    process.exit(1);
  }
  writeFileSync(ITACHI_KEY_FILE, passphrase);
  if (PLATFORM !== 'windows') { try { chmodSync(ITACHI_KEY_FILE, 0o600); } catch {} }
  log(`  Saved to ${ITACHI_KEY_FILE}`, 'gray');
  return passphrase;
}

async function step3_syncKeys(passphrase) {
  // Try to load existing API key for auth
  const existing = loadApiKeys();
  if (existing.ITACHI_API_KEY) API_KEY = existing.ITACHI_API_KEY;

  // Try pulling keys from remote sync
  let pulledFromRemote = false;
  try {
    const fileData = await httpGet(`${API_URL}/api/sync/pull/_global/${encodeURIComponent('api-keys')}`);
    const remoteContent = decrypt(fileData.encrypted_data, fileData.salt, passphrase);
    const remoteKV = {};
    for (const line of remoteContent.split('\n')) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) remoteKV[m[1]] = m[2];
    }

    // Merge: remote wins for shared keys, local machine keys preserved
    const localKV = loadApiKeys();
    const merged = { ...localKV, ...remoteKV };
    for (const mk of MACHINE_KEYS) {
      if (localKV[mk]) merged[mk] = localKV[mk];
      else delete merged[mk];
    }

    saveApiKeys(merged);
    if (merged.ITACHI_API_KEY) API_KEY = merged.ITACHI_API_KEY;
    const count = Object.keys(merged).length;
    log(`  Pulling keys from sync... OK (${count} keys loaded)`, 'green');
    pulledFromRemote = true;
  } catch (e) {
    if (e.message?.includes('Unsupported state') || e.message?.includes('wrong final block')) {
      log('  Sync decryption failed — wrong passphrase?', 'red');
      log('  Delete ~/.itachi-key and re-run to try a different passphrase.', 'yellow');
      process.exit(1);
    }
    // Not found or network error — first machine
  }

  if (!pulledFromRemote) {
    log('  No sync data found. Setting up from scratch.', 'yellow');
    const existingKeys = loadApiKeys();

    // Try bootstrap endpoint for ITACHI_API_KEY
    try {
      const bootstrap = await httpGet(`${API_URL}/api/bootstrap`);
      if (bootstrap.encrypted_config && bootstrap.salt) {
        const config = JSON.parse(decrypt(bootstrap.encrypted_config, bootstrap.salt, passphrase));
        if (config.ITACHI_API_KEY && !existingKeys.ITACHI_API_KEY) {
          existingKeys.ITACHI_API_KEY = config.ITACHI_API_KEY;
          API_KEY = config.ITACHI_API_KEY;
          log('  Got ITACHI_API_KEY from bootstrap', 'green');
        }
      }
    } catch { /* bootstrap not available */ }

    log('');
    log('  Enter API keys (press Enter to skip):', 'yellow');
    let changed = false;
    for (const cred of CREDENTIALS) {
      const existing = existingKeys[cred.key];
      const display = existing ? `****${existing.slice(-4)}` : '(not set)';
      const hint = cred.hint ? ` — ${cred.hint}` : '';
      const input = await ask(`    ${cred.label}${hint} [${display}]: `);
      if (input?.trim()) {
        existingKeys[cred.key] = input.trim();
        changed = true;
      }
    }

    if (changed || Object.keys(existingKeys).length > 0) {
      saveApiKeys(existingKeys);
      if (existingKeys.ITACHI_API_KEY) API_KEY = existingKeys.ITACHI_API_KEY;
    }

    // Push to sync for other machines
    if (Object.keys(existingKeys).length > 0) {
      try {
        const content = Object.entries(existingKeys)
          .filter(([k]) => !MACHINE_KEYS.includes(k))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join('\n') + '\n';
        const enc = encrypt(content, passphrase);
        await httpPost(`${API_URL}/api/sync/push`, {
          repo_name: '_global', file_path: 'api-keys',
          ...enc, updated_by: hostname(),
        });
        log('  Pushing keys to sync... OK', 'green');
      } catch {
        log('  Could not push to sync (server unreachable)', 'yellow');
      }
    }
  }

  // Source keys into process.env
  const keys = loadApiKeys();
  for (const [k, v] of Object.entries(keys)) process.env[k] = v;
  process.env.ITACHI_API_URL = API_URL;
}

function step4_installHooks() {
  log('  [1/5] Installing hooks..............', 'yellow');
  ensureDir(HOOKS_DIR);

  const hookSubdir = PLATFORM === 'windows' ? 'windows' : 'unix';
  const hookExt = PLATFORM === 'windows' ? '.ps1' : '.sh';
  const hookFiles = ['after-edit', 'session-start', 'session-end', 'user-prompt-submit', 'skill-sync'];
  let count = 0;

  for (const hook of hookFiles) {
    const src = join(__dirname, 'hooks', hookSubdir, `${hook}${hookExt}`);
    const dst = join(HOOKS_DIR, `${hook}${hookExt}`);
    if (existsSync(src)) {
      copyFileSync(src, dst);
      if (PLATFORM !== 'windows') { try { chmodSync(dst, 0o755); } catch {} }
      count++;
    }
  }

  log(`${C.reset}${C.green}  [1/5] Installing hooks.............. OK (${count} hooks)${C.reset}`);
}

function step5_installSkills() {
  log('  [2/5] Installing skills.............', 'yellow');
  let count = 0;

  for (const skill of ALL_SKILLS) {
    const src = join(__dirname, 'skills', skill, 'SKILL.md');
    const dst = join(SKILLS_DIR, skill, 'SKILL.md');
    if (existsSync(src)) {
      ensureDir(dirname(dst));
      copyFileSync(src, dst);
      count++;
    }
  }

  log(`${C.reset}${C.green}  [2/5] Installing skills............. OK (${count} skills)${C.reset}`);
}

function step6_installMCP() {
  log('  [3/5] Installing MCP server.........', 'yellow');
  const mcpDir = join(__dirname, 'mcp');

  if (!existsSync(join(mcpDir, 'package.json'))) {
    log(`${C.reset}${C.yellow}  [3/5] Installing MCP server......... SKIP (no mcp/package.json)${C.reset}`);
    return;
  }

  try {
    execSync('npm install --omit=dev', { cwd: mcpDir, stdio: 'pipe' });
    log(`${C.reset}${C.green}  [3/5] Installing MCP server......... OK${C.reset}`);
  } catch (e) {
    log(`${C.reset}${C.red}  [3/5] Installing MCP server......... FAILED: ${e.message}${C.reset}`);
  }
}

function step7_configureSettings() {
  log('  [4/5] Configuring settings.json.....', 'yellow');
  const settingsPath = join(CLAUDE_DIR, 'settings.json');

  // Create if it doesn't exist
  if (!existsSync(settingsPath)) {
    ensureDir(CLAUDE_DIR);
    writeFileSync(settingsPath, '{}');
  }

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    settings = {};
  }

  if (!settings.hooks) settings.hooks = {};

  // Remove existing Itachi hooks
  const itachiMarkers = ['session-start', 'after-edit', 'session-end', 'user-prompt-submit'];
  const isItachiHook = (cmd) => itachiMarkers.some(m => cmd?.toLowerCase().includes(m));

  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = (settings.hooks[event] || []).filter(entry => {
      if (!entry.hooks) return true;
      return !entry.hooks.some(h => isItachiHook(h.command));
    });
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  // Add fresh hooks
  if (PLATFORM === 'windows') {
    const ps = (script) => `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "${join(HOOKS_DIR, script)}"`;
    settings.hooks.SessionStart = [...(settings.hooks.SessionStart || []),
      { hooks: [{ type: 'command', command: ps('session-start.ps1'), timeout: 30 }] }];
    settings.hooks.PostToolUse = [...(settings.hooks.PostToolUse || []),
      { matcher: 'Write|Edit', hooks: [{ type: 'command', command: ps('after-edit.ps1'), timeout: 30 }] }];
    settings.hooks.UserPromptSubmit = [...(settings.hooks.UserPromptSubmit || []),
      { hooks: [{ type: 'command', command: ps('user-prompt-submit.ps1'), timeout: 8 }] }];
    settings.hooks.SessionEnd = [...(settings.hooks.SessionEnd || []),
      { hooks: [{ type: 'command', command: ps('session-end.ps1'), timeout: 30 }] }];
  } else {
    const sh = (script) => `bash ${join(HOOKS_DIR, script)}`;
    settings.hooks.SessionStart = [...(settings.hooks.SessionStart || []),
      { hooks: [{ type: 'command', command: sh('session-start.sh'), timeout: 30 }] }];
    settings.hooks.PostToolUse = [...(settings.hooks.PostToolUse || []),
      { matcher: 'Write|Edit', hooks: [{ type: 'command', command: sh('after-edit.sh'), timeout: 30 }] }];
    settings.hooks.UserPromptSubmit = [...(settings.hooks.UserPromptSubmit || []),
      { hooks: [{ type: 'command', command: sh('user-prompt-submit.sh'), timeout: 8 }] }];
    settings.hooks.SessionEnd = [...(settings.hooks.SessionEnd || []),
      { hooks: [{ type: 'command', command: sh('session-end.sh'), timeout: 30 }] }];
  }

  // Add MCP server entry
  if (!settings.mcpServers) settings.mcpServers = {};
  delete settings.mcpServers.lotitachi;
  settings.mcpServers.itachi = {
    command: 'node',
    args: ['index.js'],
    cwd: join(__dirname, 'mcp').replace(/\\/g, '/'),
  };

  // Atomic write: write to tmp then rename
  const tmpPath = settingsPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
  renameSync(tmpPath, settingsPath);

  // Clean settings.local.json if it has hooks
  const localSettingsPath = join(CLAUDE_DIR, 'settings.local.json');
  if (existsSync(localSettingsPath)) {
    try {
      const local = JSON.parse(readFileSync(localSettingsPath, 'utf8'));
      if (local.hooks) {
        delete local.hooks;
        writeFileSync(localSettingsPath, JSON.stringify(local, null, 2));
      }
    } catch {}
  }

  log(`${C.reset}${C.green}  [4/5] Configuring settings.json..... OK${C.reset}`);
}

async function step8_testConnectivity() {
  log('  [5/5] Testing connectivity..........', 'yellow');

  try {
    const health = await httpGet(`${API_URL}/health`);
    log(`${C.reset}${C.green}  [5/5] Testing connectivity.......... OK (API: healthy)${C.reset}`);
  } catch (e) {
    log(`${C.reset}${C.red}  [5/5] Testing connectivity.......... FAILED${C.reset}`);
    log(`        ${e.message}`, 'gray');
    log(`        Try: curl ${API_URL}/health`, 'gray');
  }
}

function step9_addShellSource() {
  if (PLATFORM === 'windows') {
    // Set ITACHI_API_URL via setx
    try {
      execSync(`setx ITACHI_API_URL "${API_URL}"`, { stdio: 'pipe' });
    } catch {}
    return;
  }

  // Unix: add source line to shell rc
  const sourceLines = [
    '',
    '# Itachi Memory System',
    `export ITACHI_API_URL="${API_URL}"`,
    '[ -f ~/.itachi-api-keys ] && set -a && source ~/.itachi-api-keys && set +a',
  ].join('\n') + '\n';

  for (const rc of ['.zshrc', '.bashrc']) {
    const rcPath = join(HOME, rc);
    if (existsSync(rcPath)) {
      const content = readFileSync(rcPath, 'utf8');
      if (!content.includes('itachi-api-keys')) {
        writeFileSync(rcPath, content + sourceLines);
      }
    }
  }
}

function step10_registerSkillSync() {
  if (OPTS.noCron) return;

  if (PLATFORM === 'windows') {
    const syncScript = join(HOOKS_DIR, 'skill-sync.ps1');
    if (!existsSync(syncScript)) return;
    try {
      execSync(
        `powershell -NoProfile -Command "` +
        `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-ExecutionPolicy Bypass -NoProfile -File \\\"${syncScript}\\\"'; ` +
        `$trigger = New-ScheduledTaskTrigger -Daily -At '3:00AM'; ` +
        `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd; ` +
        `Register-ScheduledTask -TaskName 'ItachiSkillSync' -Action $action -Trigger $trigger -Settings $settings -Description 'Daily sync of Claude Code skills' -Force"`,
        { stdio: 'pipe' }
      );
    } catch { /* non-critical */ }
  } else {
    const syncScript = join(HOOKS_DIR, 'skill-sync.sh');
    if (!existsSync(syncScript)) return;
    try {
      const cronCmd = `bash ${syncScript} >> ${HOME}/.claude/.skill-sync.log 2>&1`;
      const cronLine = `0 3 * * * ${cronCmd}`;
      execSync(
        `(crontab -l 2>/dev/null | grep -v "skill-sync.sh"; echo "${cronLine}") | crontab -`,
        { stdio: 'pipe', shell: '/bin/sh' }
      );
    } catch { /* non-critical */ }
  }
}

// ── Full Mode: Auth Sync ────────────────────────────────

function findClaudeCredentials() {
  const locations = [
    join(CLAUDE_DIR, '.credentials.json'),
    join(PLATFORM === 'windows'
      ? join(process.env.APPDATA || '', 'claude-code', 'credentials.json')
      : join(HOME, '.config', 'claude-code', 'credentials.json')),
  ];
  return locations.find(p => existsSync(p)) || null;
}

function findCodexCredentials() {
  const codexAuth = join(HOME, '.codex', 'auth.json');
  return existsSync(codexAuth) ? codexAuth : null;
}

async function encryptAndPush(content, passphrase, repoName, filePath) {
  const enc = encrypt(content, passphrase);
  return httpPost(`${API_URL}/api/sync/push`, {
    repo_name: repoName, file_path: filePath,
    ...enc, updated_by: hostname(),
  });
}

async function syncAuthCredentials(passphrase) {
  log('\n  [auth] Syncing CLI credentials...', 'yellow');

  // Claude auth
  const claudeCreds = findClaudeCredentials();
  if (claudeCreds) {
    try {
      await encryptAndPush(readFileSync(claudeCreds, 'utf8'), passphrase, '_global', 'claude-auth');
      log('    Claude auth: pushed to sync', 'gray');
    } catch { log('    Claude auth: push failed', 'gray'); }
  } else {
    // Try pulling from sync
    try {
      const fileData = await httpGet(`${API_URL}/api/sync/pull/_global/claude-auth`);
      const content = decrypt(fileData.encrypted_data, fileData.salt, passphrase);
      const credPath = join(CLAUDE_DIR, '.credentials.json');
      ensureDir(dirname(credPath));
      writeFileSync(credPath, content);
      log('    Claude auth: pulled from sync', 'green');
    } catch {
      log('    Claude auth: not found (run "claude" to authenticate)', 'yellow');
    }
  }

  // Codex auth
  if (commandExists('codex')) {
    const codexCreds = findCodexCredentials();
    if (codexCreds) {
      try {
        await encryptAndPush(readFileSync(codexCreds, 'utf8'), passphrase, '_global', 'codex-auth');
        log('    Codex auth: pushed to sync', 'gray');
      } catch { log('    Codex auth: push failed', 'gray'); }
    } else {
      try {
        const fileData = await httpGet(`${API_URL}/api/sync/pull/_global/codex-auth`);
        const content = decrypt(fileData.encrypted_data, fileData.salt, passphrase);
        const codexDir = join(HOME, '.codex');
        ensureDir(codexDir);
        writeFileSync(join(codexDir, 'auth.json'), content);
        log('    Codex auth: pulled from sync', 'green');
      } catch {
        log('    Codex auth: not found (run "codex login" to authenticate)', 'gray');
      }
    }
  }
}

// ── Full Mode: Supabase Bootstrap ───────────────────────

async function bootstrapSupabase(passphrase) {
  log('\n  [supabase] Bootstrapping credentials...', 'yellow');
  const credFile = join(HOME, '.supabase-credentials');
  let supaUrl = null, supaKey = null;

  if (existsSync(credFile)) {
    const content = readFileSync(credFile, 'utf8');
    const urlMatch = content.match(/SUPABASE_URL=(.+)/);
    const keyMatch = content.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/) || content.match(/SUPABASE_KEY=(.+)/);
    if (urlMatch) supaUrl = urlMatch[1].trim();
    if (keyMatch) supaKey = keyMatch[1].trim();
    if (supaUrl && supaKey) {
      log(`    Found existing credentials at ${credFile}`, 'gray');
      return { supaUrl, supaKey };
    }
  }

  try {
    const bootstrap = await httpGet(`${API_URL}/api/bootstrap`);
    if (bootstrap.encrypted_config && bootstrap.salt) {
      const config = JSON.parse(decrypt(bootstrap.encrypted_config, bootstrap.salt, passphrase));
      supaUrl = config.SUPABASE_URL;
      supaKey = config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_KEY;
      writeFileSync(credFile, `SUPABASE_URL=${supaUrl}\nSUPABASE_SERVICE_ROLE_KEY=${supaKey}\n`);
      if (PLATFORM !== 'windows') { try { chmodSync(credFile, 0o600); } catch {} }
      log(`    Bootstrapped from server`, 'green');
    }
  } catch (e) {
    if (e.message?.includes('Unsupported') || e.message?.includes('wrong final block')) {
      log('    Bootstrap decryption failed — passphrase mismatch with bootstrap data', 'yellow');
    }
    log('    Bootstrap not available. Entering manually.', 'yellow');
    supaUrl = await ask('    SUPABASE_URL: ');
    supaKey = await ask('    SUPABASE_SERVICE_ROLE_KEY: ');
    if (supaUrl && supaKey) {
      writeFileSync(credFile, `SUPABASE_URL=${supaUrl}\nSUPABASE_SERVICE_ROLE_KEY=${supaKey}\n`);
      if (PLATFORM !== 'windows') { try { chmodSync(credFile, 0o600); } catch {} }
    }
  }

  return { supaUrl, supaKey };
}

// ── Full Mode: Persistent Env Vars ──────────────────────

function setEnvVarsFull() {
  log('\n  [env] Setting persistent environment variables...', 'yellow');
  const keys = loadApiKeys();
  keys['ITACHI_API_URL'] = API_URL;

  if (PLATFORM === 'windows') {
    let count = 0;
    for (const [k, v] of Object.entries(keys)) {
      if (MACHINE_KEYS.includes(k)) continue;
      try { execSync(`setx ${k} "${v}"`, { stdio: 'pipe' }); count++; } catch {}
    }
    log(`    Set ${count} user env var(s) via setx`, 'gray');
    log('    NOTE: Open a new terminal for changes to take effect.', 'yellow');
  } else {
    // Handled by step9_addShellSource already — this adds all keys via setx on Windows
    log('    Shell rc already configured (source ~/.itachi-api-keys)', 'gray');
  }
}

// ── Full Mode: Itachi CLI Wrapper ───────────────────────

function getNpmGlobalBin() {
  try {
    return execSync('npm bin -g', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return PLATFORM === 'windows' ? join(process.env.APPDATA || '', 'npm') : '/usr/local/bin';
  }
}

function installWrapper() {
  log('\n  [wrapper] Installing itachi command...', 'yellow');
  const binDir = join(__dirname, 'bin');
  ensureDir(binDir);

  const unixWrapper = `#!/bin/bash
# Itachi Memory System - Claude Code wrapper
ITACHI_KEYS_FILE="\${HOME}/.itachi-api-keys"
if [ -f "\${ITACHI_KEYS_FILE}" ]; then set -a; source "\${ITACHI_KEYS_FILE}"; set +a; fi
export ITACHI_API_URL="\${ITACHI_API_URL:-${API_URL}}"
exec claude "$@"
`;

  const windowsCmd = `@echo off
REM Itachi Memory System - Claude Code wrapper
set "ITACHI_KEYS_FILE=%USERPROFILE%\\.itachi-api-keys"
if exist "%ITACHI_KEYS_FILE%" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%ITACHI_KEYS_FILE%") do set "%%a=%%b"
)
if not defined ITACHI_API_URL set "ITACHI_API_URL=${API_URL}"
claude %*
`;

  const windowsPs1 = `# Itachi Memory System - Claude Code wrapper
$keysFile = Join-Path $env:USERPROFILE ".itachi-api-keys"
if (Test-Path $keysFile) {
    Get-Content $keysFile | ForEach-Object {
        if ($_ -match '^([A-Za-z_][A-Za-z0-9_]*)=(.+)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
        }
    }
}
if (-not $env:ITACHI_API_URL) { $env:ITACHI_API_URL = "${API_URL}" }
claude @args
`;

  writeFileSync(join(binDir, 'itachi'), unixWrapper);
  writeFileSync(join(binDir, 'itachi.cmd'), windowsCmd);
  writeFileSync(join(binDir, 'itachi.ps1'), windowsPs1);
  if (PLATFORM !== 'windows') { try { chmodSync(join(binDir, 'itachi'), 0o755); } catch {} }

  const globalBin = getNpmGlobalBin();
  try {
    if (PLATFORM === 'windows') {
      copyFileSync(join(binDir, 'itachi.cmd'), join(globalBin, 'itachi.cmd'));
    } else {
      const target = join(globalBin, 'itachi');
      copyFileSync(join(binDir, 'itachi'), target);
      try { chmodSync(target, 0o755); } catch {}
    }
    log(`    Installed to ${globalBin}`, 'green');
    log('    Use "itachi" instead of "claude" for full system integration.', 'green');
  } catch (e) {
    log(`    Could not install to ${globalBin}: ${e.message}`, 'yellow');
    if (PLATFORM === 'windows') {
      log(`    Copy "${join(binDir, 'itachi.cmd')}" to a directory in your PATH`, 'gray');
    } else {
      log(`    sudo cp "${join(binDir, 'itachi')}" /usr/local/bin/itachi`, 'gray');
    }
  }
}

// ── Full Mode: Orchestrator Setup ───────────────────────

async function setupOrchestrator(supaUrl, supaKey) {
  log('\n  === Orchestrator (Task Runner) ===', 'cyan');
  const ORCH_DIR = join(__dirname, 'orchestrator');

  if (!existsSync(ORCH_DIR)) {
    log('    Orchestrator directory not found. Skipping.', 'yellow');
    return;
  }

  const orchEnv = join(ORCH_DIR, '.env');
  let useSecrets = false;

  if (!existsSync(orchEnv)) {
    // Check itachi-secrets for shared config
    const secretsJs = join(__dirname, 'tools', 'dist', 'itachi-secrets.js');
    if (!existsSync(secretsJs)) {
      try { execSync('npm install && npx tsc', { cwd: join(__dirname, 'tools'), stdio: 'pipe' }); } catch {}
    }

    if (existsSync(secretsJs) && supaUrl && supaKey) {
      try {
        const env = { ...process.env, SUPABASE_URL: supaUrl, SUPABASE_SERVICE_ROLE_KEY: supaKey };
        const listOutput = execSync(`node "${secretsJs}" list`, { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
        if (listOutput.includes('orchestrator-env')) {
          log('    Found shared orchestrator config in itachi-secrets.', 'green');
          const pullChoice = await ask('    Pull it? (y/n): ');
          if (pullChoice.toLowerCase() === 'y') {
            execSync(`node "${secretsJs}" pull orchestrator-env --out "${orchEnv}"`, { env, stdio: 'pipe' });
            useSecrets = true;
            log('    Pulled .env from itachi-secrets', 'green');
          }
        }
      } catch { log('    Could not check itachi-secrets', 'gray'); }
    }
  } else {
    log(`    Found existing .env at ${orchEnv}`, 'gray');
    useSecrets = true;
  }

  const defaultId = hostname().toLowerCase().replace(/ /g, '-').replace(/[^a-z0-9-]/g, '');
  const orchId = (await ask(`    Orchestrator ID [${defaultId}]: `)) || defaultId;
  const defaultWs = join(HOME, 'itachi-workspaces');
  const wsDir = (await ask(`    Workspace directory [${defaultWs}]: `)) || defaultWs;
  ensureDir(wsDir);

  const machineId = (await ask(`    Machine ID [${defaultId}]: `)) || defaultId;
  const machineName = (await ask(`    Machine display name [${machineId}]: `)) || machineId;

  if (useSecrets) {
    let content = readFileSync(orchEnv, 'utf8');
    content = content.replace(/ITACHI_ORCHESTRATOR_ID=.+/, `ITACHI_ORCHESTRATOR_ID=${orchId}`);
    content = content.replace(/ITACHI_WORKSPACE_DIR=.+/, `ITACHI_WORKSPACE_DIR=${wsDir}`);
    content = content.replace(/ITACHI_PROJECT_PATHS=\{.+\}/, 'ITACHI_PROJECT_PATHS={}');
    if (!content.includes('ITACHI_MACHINE_ID=')) content += `\nITACHI_MACHINE_ID=${machineId}`;
    else content = content.replace(/ITACHI_MACHINE_ID=.+/, `ITACHI_MACHINE_ID=${machineId}`);
    if (!content.includes('ITACHI_MACHINE_NAME=')) content += `\nITACHI_MACHINE_NAME=${machineName}`;
    else content = content.replace(/ITACHI_MACHINE_NAME=.+/, `ITACHI_MACHINE_NAME=${machineName}`);
    writeFileSync(orchEnv, content);
  } else {
    const maxConc = (await ask('    Max concurrent sessions [5]: ')) || '5';
    writeFileSync(orchEnv, [
      `SUPABASE_URL=${supaUrl || ''}`, `SUPABASE_SERVICE_ROLE_KEY=${supaKey || ''}`,
      `ITACHI_ORCHESTRATOR_ID=${orchId}`, `ITACHI_MAX_CONCURRENT=${maxConc}`,
      `ITACHI_WORKSPACE_DIR=${wsDir}`, `ITACHI_TASK_TIMEOUT_MS=600000`,
      `ITACHI_DEFAULT_MODEL=sonnet`, `ITACHI_DEFAULT_BUDGET=5.00`,
      `ITACHI_POLL_INTERVAL_MS=5000`, `ITACHI_PROJECT_PATHS={}`,
      `ITACHI_API_URL=${API_URL}`, `ITACHI_DEFAULT_ENGINE=claude`,
      `ITACHI_MACHINE_ID=${machineId}`, `ITACHI_MACHINE_NAME=${machineName}`,
    ].join('\n') + '\n');
  }

  log('\n    Building orchestrator...', 'yellow');
  try {
    execSync('npm install', { cwd: ORCH_DIR, stdio: 'inherit' });
    execSync('npm run build', { cwd: ORCH_DIR, stdio: 'inherit' });
    log('    Build OK', 'green');
  } catch (e) {
    log(`    Build FAILED: ${e.message}`, 'red');
    return;
  }

  log('');
  log('    The orchestrator needs to run continuously to pick up tasks.', 'yellow');
  log('      1) Start with PM2 (recommended)');
  log('      2) Start in foreground (for testing)');
  log('      3) Skip — I\'ll start it myself later');
  log('');
  const startChoice = await ask('    Choose [1/2/3]: ');
  const indexJs = join(ORCH_DIR, 'dist', 'index.js');

  switch (startChoice.trim()) {
    case '1':
      if (!commandExists('pm2')) { execSync('npm install -g pm2', { stdio: 'inherit' }); }
      execSync(`pm2 start "${indexJs}" --name itachi-orchestrator`, { stdio: 'inherit' });
      execSync('pm2 save', { stdio: 'inherit' });
      log('\n    Started with PM2.', 'green');
      if (PLATFORM !== 'windows') log('    Run "pm2 startup" to auto-start on boot.', 'gray');
      log('    Logs: pm2 logs itachi-orchestrator', 'gray');
      break;
    case '2':
      log('\n    Starting in foreground (Ctrl+C to stop)...', 'yellow');
      rl.close();
      execSync(`node "${indexJs}"`, { stdio: 'inherit' });
      return;
    default:
      log(`\n    Skipped. Start later: node "${indexJs}"`, 'gray');
  }
}

// ── Main ────────────────────────────────────────────────
async function main() {
  try {
    // Self-update: git pull then re-exec without --update flag
    if (OPTS.update) {
      log('\n  Updating itachi-memory...', 'yellow');
      try {
        const output = execSync('git pull --ff-only', { cwd: __dirname, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        if (output.includes('Already up to date')) {
          log('  Already up to date.', 'gray');
        } else {
          log('  Pulled latest changes.', 'green');
        }
      } catch (e) {
        // Try regular pull if ff-only fails (diverged)
        try {
          execSync('git pull', { cwd: __dirname, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
          log('  Pulled latest changes.', 'green');
        } catch {
          log(`  git pull failed: ${e.message}`, 'red');
          log('  Continuing with current version.', 'yellow');
        }
      }
      // Re-exec self without --update to avoid infinite loop
      const args = process.argv.slice(2).filter(a => a !== '--update' && a !== '-u');
      const { execFileSync } = await import('child_process');
      execFileSync(process.execPath, [__filename, ...args], { stdio: 'inherit', cwd: process.cwd() });
      process.exit(0);
    }

    step1_detectPlatform();

    const passphrase = await step2_loadOrCreatePassphrase();
    await step3_syncKeys(passphrase);

    log('');
    step4_installHooks();
    step5_installSkills();
    step6_installMCP();
    step7_configureSettings();
    await step8_testConnectivity();
    step9_addShellSource();
    step10_registerSkillSync();

    if (OPTS.full) {
      log('\n  === Full Setup ===', 'cyan');
      await syncAuthCredentials(passphrase);
      const { supaUrl, supaKey } = await bootstrapSupabase(passphrase);
      setEnvVarsFull();
      installWrapper();
      await setupOrchestrator(supaUrl, supaKey);
    }

    log('');
    log('  Done! Start a new Claude Code session to verify.', 'green');
    if (OPTS.full) log('  Use "itachi" instead of "claude" for full system integration.', 'green');
    log('');
  } catch (e) {
    log(`\n  ERROR: ${e.message}`, 'red');
    if (e.stack) log(e.stack, 'gray');
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
