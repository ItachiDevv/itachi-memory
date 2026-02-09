#!/usr/bin/env node
// Itachi Memory System - Unified Cross-Platform Setup
// Single entry point that bootstraps a fresh machine completely.
//
// Usage:
//   node setup.mjs                # Full setup (hooks + orchestrator)
//   node setup.mjs --hooks-only   # Skip orchestrator setup
//
import { createInterface } from 'readline';
import { execSync, spawn } from 'child_process';
import { createHash, pbkdf2Sync, createDecipheriv, randomBytes, createCipheriv } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { homedir, hostname, platform as osPlatform } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============ Config ============
const API_URL = 'https://itachisbrainserver.online';
const PLATFORM = osPlatform() === 'win32' ? 'windows' : osPlatform() === 'darwin' ? 'macos' : 'linux';
const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const HOOKS_DIR = join(CLAUDE_DIR, 'hooks');
const COMMANDS_DIR = join(CLAUDE_DIR, 'commands');
const SKILLS_DIR = join(CLAUDE_DIR, 'skills');
const ORCH_DIR = join(__dirname, 'orchestrator');
const HOOKS_ONLY = process.argv.includes('--hooks-only');
const API_KEYS_FILE = join(HOME, '.itachi-api-keys');
const ITACHI_KEY_FILE = join(HOME, '.itachi-key');

// All supported API credentials
const CREDENTIALS = [
  { key: 'ITACHI_API_KEY',         label: 'Itachi API Key',               hint: 'Required for all hooks/orchestrator auth' },
  { key: 'GITHUB_TOKEN',           label: 'GitHub Personal Access Token', hint: 'ghp_... (repo, workflow scopes)' },
  { key: 'VERCEL_TOKEN',           label: 'Vercel Token',                 hint: 'from vercel.com/account/tokens' },
  { key: 'SUPABASE_ACCESS_TOKEN',  label: 'Supabase Access Token',        hint: 'from supabase.com/dashboard/account/tokens' },
  { key: 'OPENAI_API_KEY',         label: 'OpenAI API Key',               hint: 'sk-... (optional, for embeddings)' },
  { key: 'GEMINI_API_KEY',         label: 'Google Gemini API Key',        hint: 'from aistudio.google.com/apikey' },
  { key: 'X_API_KEY',              label: 'X (Twitter) API Key',          hint: 'from developer.x.com' },
  { key: 'X_API_SECRET',           label: 'X (Twitter) API Secret',       hint: '' },
  { key: 'X_ACCESS_TOKEN',         label: 'X Access Token',               hint: 'OAuth 1.0a user token' },
  { key: 'X_ACCESS_TOKEN_SECRET',  label: 'X Access Token Secret',        hint: '' },
  { key: 'X_BEARER_TOKEN',         label: 'X Bearer Token',               hint: 'App-only auth' },
];

// Machine-specific keys (never synced)
const MACHINE_KEYS = ['ITACHI_ORCHESTRATOR_ID', 'ITACHI_WORKSPACE_DIR', 'ITACHI_PROJECT_PATHS', 'ITACHI_MACHINE_ID', 'ITACHI_MACHINE_NAME'];

// All skills to install
const ALL_SKILLS = [
  'itachi-init', 'itachi-env', 'github', 'vercel', 'supabase', 'x-api',
  'elizaos', 'google-gemini', 'polymarket-api', 'tamagotchi-sprites',
  'threejs-animation', 'threejs-fundamentals', 'threejs-geometry', 'threejs-interaction',
  'threejs-lighting', 'threejs-loaders', 'threejs-materials', 'threejs-postprocessing',
  'threejs-shaders', 'threejs-textures',
];

// ============ State ============
let API_KEY = ''; // Set after bootstrap, used for auth on all subsequent requests

// ============ Helpers ============
const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt) {
  return new Promise(r => rl.question(prompt, r));
}

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

function log(msg, color = '') {
  const colors = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m', reset: '\x1b[0m' };
  const c = colors[color] || '';
  console.log(`${c}${msg}${c ? colors.reset : ''}`);
}

function commandExists(cmd) {
  try {
    if (PLATFORM === 'windows') {
      execSync(`where ${cmd}`, { stdio: 'pipe' });
    } else {
      execSync(`command -v ${cmd}`, { stdio: 'pipe', shell: '/bin/sh' });
    }
    return true;
  } catch { return false; }
}

async function httpGet(url) {
  const headers = {};
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  // Strategy 1: Node.js fetch
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    if (res.ok) {
      try { return JSON.parse(text); } catch { return text; }
    }
    // If we got a 404 with ElizaOS catch-all signature, try curl fallback
    if (res.status === 404 && text.includes('API endpoint not found')) {
      log(`  [httpGet] fetch got 404 for ${url}, trying curl fallback...`, 'gray');
    } else {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
  } catch (fetchErr) {
    if (fetchErr.message && !fetchErr.message.includes('API endpoint not found')) {
      // For non-404 errors, try curl fallback too
      log(`  [httpGet] fetch failed: ${fetchErr.message}, trying curl fallback...`, 'gray');
    }
  }

  // Strategy 2: curl subprocess (bypasses Node.js HTTP stack entirely)
  try {
    const curlHeaders = ['-H', 'Accept: application/json'];
    if (API_KEY) curlHeaders.push('-H', `Authorization: Bearer ${API_KEY}`);
    const curlCmd = PLATFORM === 'windows'
      ? `curl -s -S --max-time 10 ${curlHeaders.map(h => `"${h}"`).join(' ')} "${url}"`
      : `curl -s -S --max-time 10 ${curlHeaders.map(h => `'${h}'`).join(' ')} '${url}'`;
    const curlResult = execSync(curlCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (curlResult) {
      try {
        const parsed = JSON.parse(curlResult);
        // Check if curl also got the 404
        if (parsed.success === false && parsed.error?.code === 404) {
          throw new Error(`HTTP 404: ${curlResult}`);
        }
        return parsed;
      } catch (parseErr) {
        if (parseErr.message.includes('HTTP 404')) throw parseErr;
        return curlResult;
      }
    }
  } catch (curlErr) {
    if (curlErr.message.includes('HTTP 404')) throw curlErr;
    log(`  [httpGet] curl fallback also failed: ${curlErr.message}`, 'gray');
  }

  // Strategy 3: Node.js https module (different HTTP stack from undici-based fetch)
  const https = await import('https');
  try {
    const result = await new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const opts = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: { ...headers, 'Accept': 'application/json' },
      };
      const req = https.get(opts, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(body)); } catch { resolve(body); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
    return result;
  } catch (httpsErr) {
    throw new Error(`All HTTP strategies failed for ${url}: ${httpsErr.message}`);
  }
}

async function httpPost(url, postBody) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  const bodyStr = JSON.stringify(postBody);

  // Strategy 1: Node.js fetch
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (res.ok) {
      try { return JSON.parse(text); } catch { return text; }
    }
    if (res.status === 404 && text.includes('API endpoint not found')) {
      log(`  [httpPost] fetch got 404, trying curl fallback...`, 'gray');
    } else {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
  } catch (fetchErr) {
    if (fetchErr.message && !fetchErr.message.includes('API endpoint not found')) {
      log(`  [httpPost] fetch failed: ${fetchErr.message}, trying curl fallback...`, 'gray');
    }
  }

  // Strategy 2: curl subprocess
  try {
    const escaped = bodyStr.replace(/'/g, "'\\''");
    const curlHeaders = ['-H', 'Content-Type: application/json'];
    if (API_KEY) curlHeaders.push('-H', `Authorization: Bearer ${API_KEY}`);
    const curlCmd = PLATFORM === 'windows'
      ? `curl -s -S --max-time 15 -X POST ${curlHeaders.map(h => `"${h}"`).join(' ')} -d "${bodyStr.replace(/"/g, '\\"')}" "${url}"`
      : `curl -s -S --max-time 15 -X POST ${curlHeaders.map(h => `'${h}'`).join(' ')} -d '${escaped}' '${url}'`;
    const curlResult = execSync(curlCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (curlResult) {
      const parsed = JSON.parse(curlResult);
      if (parsed.success === false && parsed.error?.code === 404) {
        throw new Error(`HTTP 404: ${curlResult}`);
      }
      return parsed;
    }
  } catch (curlErr) {
    if (curlErr.message.includes('HTTP 404')) throw curlErr;
    log(`  [httpPost] curl fallback also failed: ${curlErr.message}`, 'gray');
  }

  // Strategy 3: Node.js https module
  const https = await import('https');
  try {
    const result = await new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const opts = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) },
      };
      const req = https.request(opts, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(body)); } catch { resolve(body); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(bodyStr);
      req.end();
    });
    return result;
  } catch (httpsErr) {
    throw new Error(`All HTTP strategies failed for ${url}: ${httpsErr.message}`);
  }
}

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

function encryptAndPush(content, passphrase, repoName, filePath) {
  const contentHash = createHash('sha256').update(content).digest('hex');
  const salt = randomBytes(16);
  const key = pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
  const packed = Buffer.concat([iv, cipher.getAuthTag(), ct]);
  return httpPost(`${API_URL}/api/sync/push`, {
    repo_name: repoName,
    file_path: filePath,
    encrypted_data: packed.toString('base64'),
    salt: salt.toString('base64'),
    content_hash: contentHash,
    updated_by: hostname(),
  });
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

function getNpmGlobalBin() {
  try {
    return execSync('npm bin -g', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return PLATFORM === 'windows' ? join(process.env.APPDATA || '', 'npm') : '/usr/local/bin';
  }
}

// ============ Steps ============

async function detectPlatform() {
  log(`\n========================================`, 'cyan');
  log(`  Itachi Memory System - Setup`, 'cyan');
  log(`========================================\n`, 'cyan');
  log(`  Platform: ${PLATFORM}`, 'gray');
}

async function checkPrerequisites() {
  log('[prereqs] Checking dependencies...', 'yellow');
  const required = ['node', 'npm', 'git', 'gh'];
  const missing = required.filter(cmd => !commandExists(cmd));

  if (missing.length > 0) {
    log(`  Missing: ${missing.join(', ')}`, 'red');
    log('');
    log('  Install them first:', 'yellow');
    if (PLATFORM === 'windows') {
      log('    winget install OpenJS.NodeJS.LTS');
      log('    winget install GitHub.cli');
      log('    winget install Git.Git');
    } else if (PLATFORM === 'macos') {
      log('    brew install node gh');
    } else {
      log('    sudo apt-get install -y nodejs npm git gh');
    }
    process.exit(1);
  }

  // Install Claude Code CLI if missing
  if (!commandExists('claude')) {
    log('  Claude Code CLI not found. Installing...', 'yellow');
    execSync('npm install -g @anthropic-ai/claude-code', { stdio: 'inherit' });
  }

  log('  All dependencies OK', 'green');
}

/**
 * Find Claude auth credential file path.
 * Returns the path if found, null otherwise.
 */
function findClaudeCredentials() {
  const locations = [
    join(CLAUDE_DIR, '.credentials.json'),
    join(PLATFORM === 'windows'
      ? join(process.env.APPDATA || '', 'claude-code', 'credentials.json')
      : join(HOME, '.config', 'claude-code', 'credentials.json')),
  ];
  return locations.find(p => existsSync(p)) || null;
}

/**
 * Find Codex auth credential file path.
 */
function findCodexCredentials() {
  const codexAuth = join(HOME, '.codex', 'auth.json');
  return existsSync(codexAuth) ? codexAuth : null;
}

/**
 * Push CLI auth credentials to sync storage so other machines can pull them.
 */
async function pushAuthCredentials(passphrase) {
  try {
    const claudeCreds = findClaudeCredentials();
    if (claudeCreds) {
      const content = readFileSync(claudeCreds, 'utf8');
      await encryptAndPush(content, passphrase, '_global', 'claude-auth');
      log('  Pushed Claude auth to sync', 'gray');
    }
    const codexCreds = findCodexCredentials();
    if (codexCreds) {
      const content = readFileSync(codexCreds, 'utf8');
      await encryptAndPush(content, passphrase, '_global', 'codex-auth');
      log('  Pushed Codex auth to sync', 'gray');
    }
  } catch {
    log('  Could not push auth credentials to sync', 'gray');
  }
}

/**
 * Pull CLI auth credentials from sync storage.
 * Returns { claude: boolean, codex: boolean } indicating what was pulled.
 */
async function pullAuthCredentials(passphrase) {
  const result = { claude: false, codex: false };
  const syncApi = `${API_URL}/api/sync`;
  try {
    // Pull Claude auth
    if (!findClaudeCredentials()) {
      try {
        const fileData = await httpGet(`${syncApi}/pull/_global/claude-auth`);
        const content = decrypt(fileData.encrypted_data, fileData.salt, passphrase);
        const credPath = join(CLAUDE_DIR, '.credentials.json');
        ensureDir(dirname(credPath));
        writeFileSync(credPath, content);
        result.claude = true;
        log('  Pulled Claude auth from sync', 'green');
      } catch {
        // No synced credentials yet
      }
    }
    // Pull Codex auth
    if (!findCodexCredentials()) {
      try {
        const fileData = await httpGet(`${syncApi}/pull/_global/codex-auth`);
        const content = decrypt(fileData.encrypted_data, fileData.salt, passphrase);
        const codexDir = join(HOME, '.codex');
        ensureDir(codexDir);
        writeFileSync(join(codexDir, 'auth.json'), content);
        result.codex = true;
        log('  Pulled Codex auth from sync', 'green');
      } catch {
        // No synced credentials yet
      }
    }
  } catch {
    // Sync unavailable
  }
  return result;
}

async function ensureClaudeAuth(passphrase) {
  log('\n[auth] Checking Claude Code authentication...', 'yellow');
  try {
    execSync('claude --version', { stdio: 'pipe' });

    if (!findClaudeCredentials()) {
      // Try pulling from sync first
      const pulled = await pullAuthCredentials(passphrase);
      if (pulled.claude) {
        log('  Claude authenticated via synced credentials.', 'green');
        return;
      }

      log('  Claude Code is installed but not authenticated.', 'yellow');
      log('  Please run this command in a separate terminal to authenticate:', 'yellow');
      log('');
      log('    claude', 'cyan');
      log('');
      log('  Complete the login flow, then close Claude and re-run setup.', 'yellow');
      log('  (Skipping auth for now — setup will continue)', 'gray');
    } else {
      log('  Claude Code is authenticated.', 'green');
      // Ensure credentials are synced
      await pushAuthCredentials(passphrase);
    }
  } catch {
    log('  Claude Code not installed or not accessible', 'gray');
  }
}

async function ensureCodexAuth(passphrase) {
  log('\n[auth] Checking Codex CLI authentication...', 'yellow');
  try {
    if (!commandExists('codex')) {
      log('  Codex CLI not installed. Skipping (install later: npm install -g @openai/codex)', 'gray');
      return;
    }

    if (!findCodexCredentials()) {
      // Try pulling from sync first
      const pulled = await pullAuthCredentials(passphrase);
      if (pulled.codex) {
        log('  Codex authenticated via synced credentials.', 'green');
        return;
      }

      log('  Codex CLI is installed but not authenticated.', 'gray');
      log('  Run "codex login" later to authenticate. Skipping.', 'gray');
    } else {
      log('  Codex CLI is authenticated.', 'green');
      // Ensure credentials are synced
      await pushAuthCredentials(passphrase);
    }
  } catch {
    log('  Could not verify Codex auth', 'gray');
  }
}

async function setupPassphrase() {
  log('\n=== Passphrase & Bootstrap ===\n', 'cyan');

  if (existsSync(ITACHI_KEY_FILE)) {
    log(`  Found existing passphrase at ${ITACHI_KEY_FILE}`, 'gray');
    return readFileSync(ITACHI_KEY_FILE, 'utf8').trim();
  }

  log('  Enter the shared Itachi passphrase (used for encrypted sync).', 'yellow');
  log('  All machines must use the same passphrase.', 'gray');
  log('');
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

async function bootstrapCredentials(passphrase) {
  const credFile = join(HOME, '.supabase-credentials');
  let supaUrl = null;
  let supaKey = null;

  if (existsSync(credFile)) {
    log(`  Found existing credentials at ${credFile}`, 'gray');
    const content = readFileSync(credFile, 'utf8');
    const urlMatch = content.match(/SUPABASE_URL=(.+)/);
    const keyMatch = content.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/) || content.match(/SUPABASE_KEY=(.+)/);
    if (urlMatch) supaUrl = urlMatch[1].trim();
    if (keyMatch) supaKey = keyMatch[1].trim();

    // Load API_KEY from existing keys file for auth on subsequent requests
    const existingKeys = loadApiKeys();
    if (existingKeys.ITACHI_API_KEY) API_KEY = existingKeys.ITACHI_API_KEY;
  }

  if (!supaUrl || !supaKey) {
    log('  Bootstrapping Supabase credentials from server...', 'yellow');
    try {
      const bootstrap = await httpGet(`${API_URL}/api/bootstrap`);
      if (bootstrap.encrypted_config && bootstrap.salt) {
        const config = JSON.parse(decrypt(bootstrap.encrypted_config, bootstrap.salt, passphrase));
        supaUrl = config.SUPABASE_URL;
        supaKey = config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_KEY;
        writeFileSync(credFile, `SUPABASE_URL=${supaUrl}\nSUPABASE_SERVICE_ROLE_KEY=${supaKey}\n`);
        if (PLATFORM !== 'windows') { try { chmodSync(credFile, 0o600); } catch {} }
        log(`  Bootstrapped credentials to ${credFile}`, 'green');

        // Extract ITACHI_API_KEY from bootstrap and add to api-keys file
        if (config.ITACHI_API_KEY) {
          API_KEY = config.ITACHI_API_KEY;
          const existingKeys = loadApiKeys();
          if (!existingKeys.ITACHI_API_KEY) {
            existingKeys.ITACHI_API_KEY = config.ITACHI_API_KEY;
            saveApiKeys(existingKeys);
            log(`  Set ITACHI_API_KEY from bootstrap`, 'green');
          }
        }
      } else {
        throw new Error('No encrypted_config');
      }
    } catch (e) {
      if (e.message.includes('DECRYPT') || e.message.includes('Unsupported')) {
        log('  WARNING: Bootstrap decryption failed (passphrase may not match bootstrap data).', 'yellow');
        log('  Falling back to manual entry.', 'yellow');
      }
      log('  Bootstrap not available. Falling back to manual entry.', 'yellow');
      supaUrl = await ask('  SUPABASE_URL: ');
      supaKey = await ask('  SUPABASE_SERVICE_ROLE_KEY: ');
      writeFileSync(credFile, `SUPABASE_URL=${supaUrl}\nSUPABASE_SERVICE_ROLE_KEY=${supaKey}\n`);
      if (PLATFORM !== 'windows') { try { chmodSync(credFile, 0o600); } catch {} }
    }
  }

  return { supaUrl, supaKey };
}

async function installHooks() {
  log('\n=== Hooks, Commands & Skills ===\n', 'cyan');

  // Create all skill directories
  log('[1/7] Creating directories...', 'yellow');
  ensureDir(HOOKS_DIR);
  ensureDir(COMMANDS_DIR);
  for (const skill of ALL_SKILLS) { ensureDir(join(SKILLS_DIR, skill)); }

  // Copy hook scripts
  log('[2/7] Installing hook scripts...', 'yellow');
  const hookSubdir = PLATFORM === 'windows' ? 'windows' : 'unix';
  const hookExt = PLATFORM === 'windows' ? '.ps1' : '.sh';
  const hookFiles = ['after-edit', 'session-start', 'session-end', 'skill-sync'];
  for (const hook of hookFiles) {
    const src = join(__dirname, 'hooks', hookSubdir, `${hook}${hookExt}`);
    const dst = join(HOOKS_DIR, `${hook}${hookExt}`);
    if (existsSync(src)) {
      copyFileSync(src, dst);
      if (PLATFORM !== 'windows') { try { chmodSync(dst, 0o755); } catch {} }
      log(`  ${hook}${hookExt}`, 'gray');
    }
  }

  // Install MCP server dependencies
  log('[2.5/7] Installing MCP server dependencies...', 'yellow');
  const mcpDir = join(__dirname, 'mcp');
  if (existsSync(join(mcpDir, 'package.json'))) {
    try {
      execSync('npm install --omit=dev', { cwd: mcpDir, stdio: 'pipe' });
      log('  MCP server dependencies installed', 'gray');
    } catch (e) {
      log(`  WARNING: MCP npm install failed: ${e.message}`, 'red');
    }
  }

  // Copy commands
  log('[3/7] Installing commands...', 'yellow');
  const cmdDir = join(__dirname, 'commands');
  if (existsSync(cmdDir)) {
    for (const f of readdirSync(cmdDir).filter(f => f.endsWith('.md'))) {
      copyFileSync(join(cmdDir, f), join(COMMANDS_DIR, f));
      log(`  ${f}`, 'gray');
    }
  }

  // Copy ALL skills
  log('[4/7] Installing skills...', 'yellow');
  for (const skill of ALL_SKILLS) {
    const src = join(__dirname, 'skills', skill, 'SKILL.md');
    const dst = join(SKILLS_DIR, skill, 'SKILL.md');
    if (existsSync(src)) {
      ensureDir(dirname(dst));
      copyFileSync(src, dst);
      log(`  ${skill}`, 'gray');
    }
  }
}

async function registerSkillSync() {
  log('[5/7] Registering daily skill sync...', 'yellow');

  if (PLATFORM === 'windows') {
    try {
      const syncScript = join(HOOKS_DIR, 'skill-sync.ps1');
      if (!existsSync(syncScript)) {
        log('  skill-sync.ps1 not found, skipping', 'gray');
        return;
      }
      execSync(
        `powershell -NoProfile -Command "` +
        `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-ExecutionPolicy Bypass -NoProfile -File \\\"${syncScript}\\\"'; ` +
        `$trigger = New-ScheduledTaskTrigger -Daily -At '3:00AM'; ` +
        `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd; ` +
        `Register-ScheduledTask -TaskName 'ItachiSkillSync' -Action $action -Trigger $trigger -Settings $settings -Description 'Daily sync of Claude Code skills' -Force"`,
        { stdio: 'pipe' }
      );
      log('  Registered: ItachiSkillSync (daily at 3:00 AM)', 'gray');
    } catch (e) {
      log(`  WARNING: Could not register scheduled task: ${e.message}`, 'red');
      log('  Run skill-sync.ps1 manually or register the task yourself.', 'gray');
    }
  } else {
    try {
      const syncScript = join(HOOKS_DIR, 'skill-sync.sh');
      if (!existsSync(syncScript)) {
        log('  skill-sync.sh not found, skipping', 'gray');
        return;
      }
      const cronCmd = `bash ${syncScript} >> ${HOME}/.claude/.skill-sync.log 2>&1`;
      const cronLine = `0 3 * * * ${cronCmd}`;
      // Remove old entry, add new one
      execSync(
        `(crontab -l 2>/dev/null | grep -v "skill-sync.sh"; echo "${cronLine}") | crontab -`,
        { stdio: 'pipe', shell: '/bin/sh' }
      );
      log('  Registered: cron job (daily at 3:00 AM)', 'gray');
    } catch {
      log('  WARNING: Could not register cron job. Run skill-sync.sh manually.', 'gray');
    }
  }
}

async function pullGlobalSync(passphrase) {
  log('[6/7] Pulling global sync (skills + commands)...', 'yellow');
  const syncApi = `${API_URL}/api/sync`;

  try {
    const list = await httpGet(`${syncApi}/list/_global`);
    if (!list.files || list.files.length === 0) {
      log('  No global files to sync', 'gray');
      return;
    }

    let synced = 0;
    for (const f of list.files) {
      // Skip settings-hooks.json and api-keys (handled separately)
      if (f.file_path === 'settings-hooks.json' || f.file_path === 'api-keys') continue;

      const localPath = join(CLAUDE_DIR, f.file_path);
      let localHash = null;
      if (existsSync(localPath)) {
        localHash = createHash('sha256').update(readFileSync(localPath, 'utf8')).digest('hex');
      }
      if (localHash === f.content_hash) continue;

      const fileData = await httpGet(`${syncApi}/pull/_global/${encodeURIComponent(f.file_path)}`);
      const content = decrypt(fileData.encrypted_data, fileData.salt, passphrase);
      ensureDir(dirname(localPath));
      writeFileSync(localPath, content);
      synced++;
    }
    if (synced > 0) log(`  Synced ${synced} global file(s)`, 'green');
    else log('  All global files up to date', 'gray');
  } catch (e) {
    log(`  Sync failed: ${e.message}`, 'red');
  }
}

async function mergeSettings() {
  log('[7/7] Updating settings.json...', 'yellow');
  const settingsPath = join(CLAUDE_DIR, 'settings.json');

  if (!existsSync(settingsPath)) {
    log(`  WARNING: ${settingsPath} not found — run 'claude' once first, then re-run setup`, 'red');
    return;
  }

  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (!settings.hooks) settings.hooks = {};

  const itachiMarkers = ['session-start', 'after-edit', 'session-end'];
  const isItachiHook = (cmd) => itachiMarkers.some(m => cmd && cmd.toLowerCase().includes(m));

  // Remove existing Itachi hooks
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = (settings.hooks[event] || []).filter(entry => {
      if (!entry.hooks) return true;
      return !entry.hooks.some(h => isItachiHook(h.command));
    });
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  // Add fresh Itachi hooks
  if (PLATFORM === 'windows') {
    const ps = (script) => `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "${join(HOOKS_DIR, script)}"`;
    settings.hooks.SessionStart = [...(settings.hooks.SessionStart || []),
      { hooks: [{ type: 'command', command: ps('session-start.ps1'), timeout: 30 }] }];
    settings.hooks.PostToolUse = [...(settings.hooks.PostToolUse || []),
      { matcher: 'Write|Edit', hooks: [{ type: 'command', command: ps('after-edit.ps1'), timeout: 30 }] }];
    settings.hooks.SessionEnd = [...(settings.hooks.SessionEnd || []),
      { hooks: [{ type: 'command', command: ps('session-end.ps1'), timeout: 30 }] }];
  } else {
    const sh = (script) => `bash ${join(HOOKS_DIR, script)}`;
    settings.hooks.SessionStart = [...(settings.hooks.SessionStart || []),
      { hooks: [{ type: 'command', command: sh('session-start.sh'), timeout: 30 }] }];
    settings.hooks.PostToolUse = [...(settings.hooks.PostToolUse || []),
      { matcher: 'Write|Edit', hooks: [{ type: 'command', command: sh('after-edit.sh'), timeout: 30 }] }];
    settings.hooks.SessionEnd = [...(settings.hooks.SessionEnd || []),
      { hooks: [{ type: 'command', command: sh('session-end.sh'), timeout: 30 }] }];
  }

  // Add Itachi MCP server (local stdio, replaces URL-based lotitachi)
  if (!settings.mcpServers) settings.mcpServers = {};
  delete settings.mcpServers.lotitachi; // Remove old URL-based entry
  const mcpCwd = join(__dirname, 'mcp').replace(/\\/g, '/');
  settings.mcpServers.itachi = {
    command: 'node',
    args: ['index.js'],
    cwd: mcpCwd,
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  log(`  Updated ${settingsPath}`, 'gray');

  // Remove hooks from settings.local.json if present
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

  log('  Hooks installed.', 'green');
}

async function setupApiKeys(passphrase) {
  log('\n=== API Credentials ===\n', 'cyan');

  // Step 1: Try to pull from remote sync (second machine gets keys for free)
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
    const keyCount = Object.keys(merged).length;
    log(`  Pulled ${keyCount} API key(s) from remote sync.`, 'green');
    pulledFromRemote = keyCount > 0;
  } catch (e) {
    log(`  API keys sync failed: ${e.message}`, 'red');
  }

  // Step 2: If sync worked, we're done. Only prompt on first machine (no sync data).
  if (pulledFromRemote) {
    const existingKeys = loadApiKeys();
    const setCount = CREDENTIALS.filter(c => existingKeys[c.key]).length;
    log(`  ${setCount}/${CREDENTIALS.length} API keys configured.`, 'green');
  } else {
    // First machine — prompt for keys
    const existingKeys = loadApiKeys();
    log('');
    log('  No synced keys found. Configure API keys (press Enter to skip):', 'yellow');
    log('');

    let changed = false;
    for (const cred of CREDENTIALS) {
      const existing = existingKeys[cred.key];
      const display = existing ? `****${existing.slice(-4)}` : '(not set)';
      const hint = cred.hint ? ` [${cred.hint}]` : '';
      const input = await ask(`  ${cred.label}${hint} [${display}]: `);
      if (input && input.trim()) {
        existingKeys[cred.key] = input.trim();
        changed = true;
      }
    }

    if (changed) {
      saveApiKeys(existingKeys);
      log('  Saved API keys.', 'green');

      // Push to remote sync for other machines
      try {
        const content = readFileSync(API_KEYS_FILE, 'utf8');
        const stripped = content.replace(new RegExp(`^(${MACHINE_KEYS.join('|')})=.*$`, 'gm'), '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
        await encryptAndPush(stripped, passphrase, '_global', 'api-keys');
        log('  Encrypted + synced to remote.', 'green');
      } catch {
        log('  Could not sync to remote (server unreachable).', 'gray');
      }
    }
  }
}

async function setEnvVars() {
  log('\n[env] Setting persistent environment variables...', 'yellow');
  const keys = loadApiKeys();

  // Always add ITACHI_API_URL
  keys['ITACHI_API_URL'] = API_URL;

  if (PLATFORM === 'windows') {
    // Set each key as a persistent user env var via setx
    let count = 0;
    for (const [k, v] of Object.entries(keys)) {
      if (MACHINE_KEYS.includes(k)) continue; // Skip machine-specific keys
      try {
        execSync(`setx ${k} "${v}"`, { stdio: 'pipe' });
        count++;
      } catch {}
    }
    log(`  Set ${count} user environment variable(s) via setx.`, 'gray');
    log('  NOTE: Open a new terminal for changes to take effect.', 'yellow');
  } else {
    // Add source line to shell rc files
    const shellRc = existsSync(join(HOME, '.zshrc')) ? join(HOME, '.zshrc') : join(HOME, '.bashrc');
    const sourceLines = [
      '',
      '# Itachi Memory System',
      `export ITACHI_API_URL="${API_URL}"`,
      `[ -f ~/.itachi-api-keys ] && set -a && source ~/.itachi-api-keys && set +a`,
    ];

    if (existsSync(shellRc)) {
      const content = readFileSync(shellRc, 'utf8');
      if (!content.includes('itachi-api-keys')) {
        writeFileSync(shellRc, content + sourceLines.join('\n') + '\n');
        log(`  Added source lines to ${basename(shellRc)}`, 'gray');
      } else {
        log(`  Source lines already in ${basename(shellRc)}`, 'gray');
      }
    }

    // Also add to the other rc file if it exists
    const otherRc = shellRc.endsWith('.zshrc') ? join(HOME, '.bashrc') : join(HOME, '.zshrc');
    if (existsSync(otherRc)) {
      const content = readFileSync(otherRc, 'utf8');
      if (!content.includes('itachi-api-keys')) {
        writeFileSync(otherRc, content + sourceLines.join('\n') + '\n');
        log(`  Added source lines to ${basename(otherRc)}`, 'gray');
      }
    }
  }
}

async function installItachiWrapper() {
  log('\n[wrapper] Installing itachi command...', 'yellow');

  const binDir = join(__dirname, 'bin');
  ensureDir(binDir);

  // Create Unix wrapper script
  const unixWrapper = `#!/bin/bash
# Itachi Memory System - Claude Code wrapper
# Loads API keys, sets env vars, and launches claude with full system context.
# Usage: itachi [claude args...]

# Load API keys
ITACHI_KEYS_FILE="\${HOME}/.itachi-api-keys"
if [ -f "\${ITACHI_KEYS_FILE}" ]; then
    set -a
    source "\${ITACHI_KEYS_FILE}"
    set +a
fi

# Set API URL
export ITACHI_API_URL="\${ITACHI_API_URL:-${API_URL}}"

# Pass all arguments through to claude
exec claude "$@"
`;

  // Create Windows wrapper (cmd)
  const windowsCmd = `@echo off
REM Itachi Memory System - Claude Code wrapper
REM Loads API keys, sets env vars, and launches claude with full system context.
REM Usage: itachi [claude args...]

REM Load API keys from file
set "ITACHI_KEYS_FILE=%USERPROFILE%\\.itachi-api-keys"
if exist "%ITACHI_KEYS_FILE%" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%ITACHI_KEYS_FILE%") do (
        set "%%a=%%b"
    )
)

REM Set API URL
if not defined ITACHI_API_URL set "ITACHI_API_URL=${API_URL}"

REM Pass all arguments through to claude
claude %*
`;

  // Create Windows wrapper (ps1) for PowerShell users
  const windowsPs1 = `# Itachi Memory System - Claude Code wrapper
# Loads API keys, sets env vars, and launches claude with full system context.
# Usage: itachi [claude args...]

# Load API keys from file
$keysFile = Join-Path $env:USERPROFILE ".itachi-api-keys"
if (Test-Path $keysFile) {
    Get-Content $keysFile | ForEach-Object {
        if ($_ -match '^([A-Za-z_][A-Za-z0-9_]*)=(.+)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
        }
    }
}

# Set API URL
if (-not $env:ITACHI_API_URL) { $env:ITACHI_API_URL = "${API_URL}" }

# Pass all arguments through to claude
claude @args
`;

  // Write wrapper scripts
  writeFileSync(join(binDir, 'itachi'), unixWrapper);
  writeFileSync(join(binDir, 'itachi.cmd'), windowsCmd);
  writeFileSync(join(binDir, 'itachi.ps1'), windowsPs1);
  if (PLATFORM !== 'windows') {
    try { chmodSync(join(binDir, 'itachi'), 0o755); } catch {}
  }

  // Install to PATH (same directory as claude CLI)
  const globalBin = getNpmGlobalBin();
  try {
    if (PLATFORM === 'windows') {
      copyFileSync(join(binDir, 'itachi.cmd'), join(globalBin, 'itachi.cmd'));
      log(`  Installed itachi.cmd to ${globalBin}`, 'gray');
    } else {
      const target = join(globalBin, 'itachi');
      copyFileSync(join(binDir, 'itachi'), target);
      try { chmodSync(target, 0o755); } catch {}
      log(`  Installed itachi to ${globalBin}`, 'gray');
    }
    log('  You can now use "itachi" instead of "claude" for full system integration.', 'green');
  } catch (e) {
    log(`  Could not install to ${globalBin}: ${e.message}`, 'yellow');
    log(`  You can manually add ${binDir} to your PATH, or run:`, 'gray');
    if (PLATFORM === 'windows') {
      log(`    copy "${join(binDir, 'itachi.cmd')}" to a directory in your PATH`, 'gray');
    } else {
      log(`    sudo cp "${join(binDir, 'itachi')}" /usr/local/bin/itachi`, 'gray');
    }
  }
}

async function testConnectivity() {
  log('\nTesting API connectivity...', 'yellow');

  // Test 1: Health endpoint
  try {
    const health = await httpGet(`${API_URL}/health`);
    log(`  /health: OK (${health.memories || 0} memories)`, 'green');
  } catch (e) {
    log(`  /health: FAILED - ${e.message}`, 'red');
  }

  // Test 2: Sync list endpoint (the one that fails on Mac)
  try {
    const list = await httpGet(`${API_URL}/api/sync/list/_global`);
    const count = list.files ? list.files.length : 0;
    log(`  /api/sync/list/_global: OK (${count} files)`, 'green');
  } catch (e) {
    log(`  /api/sync/list/_global: FAILED - ${e.message}`, 'red');

    // Run diagnostics
    log('', '');
    log('  === Diagnostics ===', 'yellow');

    // DNS check
    try {
      const dns = await import('dns');
      const addresses = await new Promise((resolve, reject) => {
        dns.default.lookup(new URL(API_URL).hostname, { all: true }, (err, addrs) => {
          if (err) reject(err); else resolve(addrs);
        });
      });
      log(`  DNS: ${JSON.stringify(addresses)}`, 'gray');
    } catch (dnsErr) {
      log(`  DNS lookup failed: ${dnsErr.message}`, 'red');
    }

    // TLS check
    try {
      const tls = await import('tls');
      const sock = tls.default.connect(443, new URL(API_URL).hostname, { servername: new URL(API_URL).hostname });
      await new Promise((resolve, reject) => {
        sock.on('secureConnect', () => {
          const cert = sock.getPeerCertificate();
          log(`  TLS: ${sock.getProtocol()}, cert CN=${cert.subject?.CN}, remote=${sock.remoteAddress}`, 'gray');
          sock.end();
          resolve();
        });
        sock.on('error', (err) => { log(`  TLS error: ${err.message}`, 'red'); resolve(); });
        setTimeout(() => { sock.destroy(); resolve(); }, 5000);
      });
    } catch {}

    // Try direct curl for comparison
    try {
      const curlResult = execSync(
        `curl -s -o /dev/null -w "%{http_code} %{remote_ip} %{ssl_verify_result}" "${API_URL}/api/sync/list/_global"`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
      ).trim();
      log(`  curl diagnostic: status=${curlResult}`, 'gray');
    } catch (curlErr) {
      log(`  curl diagnostic failed: ${curlErr.message}`, 'gray');
    }
  }

  // Test 3: Bootstrap endpoint (for comparison)
  try {
    const bootstrap = await httpGet(`${API_URL}/api/bootstrap`);
    log(`  /api/bootstrap: OK`, 'green');
  } catch (e) {
    log(`  /api/bootstrap: FAILED - ${e.message}`, 'red');
  }
}

async function setupOrchestrator(supaUrl, supaKey) {
  log('\n=== Orchestrator (Task Runner) ===\n', 'cyan');

  const orchEnv = join(ORCH_DIR, '.env');
  let useSecrets = false;

  if (!existsSync(orchEnv)) {
    log('  No orchestrator .env found.', 'yellow');
    log('  Checking itachi-secrets for a shared config...', 'gray');

    const secretsJs = join(__dirname, 'tools', 'dist', 'itachi-secrets.js');
    if (!existsSync(secretsJs)) {
      log('  Building itachi-secrets tool...', 'gray');
      try {
        execSync('npm install && npx tsc', { cwd: join(__dirname, 'tools'), stdio: 'pipe' });
      } catch {}
    }

    if (existsSync(secretsJs)) {
      try {
        const env = { ...process.env, SUPABASE_URL: supaUrl, SUPABASE_SERVICE_ROLE_KEY: supaKey };
        const listOutput = execSync(`node "${secretsJs}" list`, { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
        if (listOutput.includes('orchestrator-env')) {
          log('  Found shared orchestrator config in itachi-secrets.', 'green');
          const pullChoice = await ask('  Pull it? (y/n): ');
          if (pullChoice.toLowerCase() === 'y') {
            execSync(`node "${secretsJs}" pull orchestrator-env --out "${orchEnv}"`, { env, stdio: 'pipe' });
            useSecrets = true;
            log('  Pulled .env from itachi-secrets', 'green');
          }
        } else {
          log('  No shared config found in itachi-secrets.', 'gray');
        }
      } catch {
        log('  Could not check itachi-secrets', 'gray');
      }
    }
  } else {
    log(`  Found existing .env at ${orchEnv}`, 'gray');
    useSecrets = true;
  }

  const defaultId = hostname().toLowerCase().replace(/ /g, '-').replace(/[^a-z0-9-]/g, '');
  const orchId = (await ask(`  Orchestrator ID [${defaultId}]: `)) || defaultId;
  const defaultWs = join(HOME, 'itachi-workspaces');
  const wsDir = (await ask(`  Workspace directory [${defaultWs}]: `)) || defaultWs;
  ensureDir(wsDir);

  // Machine dispatch config
  const defaultMachineId = hostname().toLowerCase().replace(/ /g, '-').replace(/[^a-z0-9-]/g, '');
  const machineId = (await ask(`  Machine ID [${defaultMachineId}]: `)) || defaultMachineId;
  const machineName = (await ask(`  Machine display name [${machineId}]: `)) || machineId;

  if (useSecrets) {
    let content = readFileSync(orchEnv, 'utf8');
    content = content.replace(/ITACHI_ORCHESTRATOR_ID=.+/, `ITACHI_ORCHESTRATOR_ID=${orchId}`);
    content = content.replace(/ITACHI_WORKSPACE_DIR=.+/, `ITACHI_WORKSPACE_DIR=${wsDir}`);
    content = content.replace(/ITACHI_PROJECT_PATHS=\{.+\}/, 'ITACHI_PROJECT_PATHS={}');
    // Add machine dispatch vars if missing
    if (!content.includes('ITACHI_MACHINE_ID=')) content += `\nITACHI_MACHINE_ID=${machineId}`;
    else content = content.replace(/ITACHI_MACHINE_ID=.+/, `ITACHI_MACHINE_ID=${machineId}`);
    if (!content.includes('ITACHI_MACHINE_NAME=')) content += `\nITACHI_MACHINE_NAME=${machineName}`;
    else content = content.replace(/ITACHI_MACHINE_NAME=.+/, `ITACHI_MACHINE_NAME=${machineName}`);
    writeFileSync(orchEnv, content);
    log('  Updated orchestrator ID, workspace, and machine config', 'gray');
  } else {
    const maxConc = (await ask('  Max concurrent sessions [5]: ')) || '5';
    writeFileSync(orchEnv, [
      `SUPABASE_URL=${supaUrl}`, `SUPABASE_SERVICE_ROLE_KEY=${supaKey}`,
      `ITACHI_ORCHESTRATOR_ID=${orchId}`, `ITACHI_MAX_CONCURRENT=${maxConc}`,
      `ITACHI_WORKSPACE_DIR=${wsDir}`, `ITACHI_TASK_TIMEOUT_MS=600000`,
      `ITACHI_DEFAULT_MODEL=sonnet`, `ITACHI_DEFAULT_BUDGET=5.00`,
      `ITACHI_POLL_INTERVAL_MS=5000`, `ITACHI_PROJECT_PATHS={}`,
      `ITACHI_API_URL=${API_URL}`,
      `ITACHI_DEFAULT_ENGINE=claude`,
      `ITACHI_MACHINE_ID=${machineId}`, `ITACHI_MACHINE_NAME=${machineName}`,
    ].join('\n') + '\n');
    log(`  Written: ${orchEnv}`, 'gray');
  }

  log('\nBuilding orchestrator...', 'yellow');
  execSync('npm install', { cwd: ORCH_DIR, stdio: 'inherit' });
  execSync('npm run build', { cwd: ORCH_DIR, stdio: 'inherit' });
  log('  Build OK', 'green');

  log('');
  log('The orchestrator needs to run continuously to pick up tasks.', 'yellow');
  log('  1) Start with PM2 (recommended)');
  log('  2) Start in foreground (for testing)');
  log('  3) Skip - I\'ll start it myself later');
  log('');
  const startChoice = await ask('Choose [1/2/3]: ');
  const indexJs = join(ORCH_DIR, 'dist', 'index.js');

  switch (startChoice.trim()) {
    case '1':
      if (!commandExists('pm2')) { execSync('npm install -g pm2', { stdio: 'inherit' }); }
      execSync(`pm2 start "${indexJs}" --name itachi-orchestrator`, { stdio: 'inherit' });
      execSync('pm2 save', { stdio: 'inherit' });
      log('\n  Started with PM2.', 'green');
      if (PLATFORM !== 'windows') { log('  Run \'pm2 startup\' to auto-start on boot.', 'gray'); }
      log('  Logs: pm2 logs itachi-orchestrator', 'gray');
      break;
    case '2':
      log('\n  Starting in foreground (Ctrl+C to stop)...', 'yellow');
      rl.close();
      execSync(`node "${indexJs}"`, { stdio: 'inherit' });
      return;
    default:
      log(`\n  Skipped. Start later: node "${indexJs}"`, 'gray');
  }
}

// ============ Main ============
async function main() {
  try {
    await detectPlatform();
    await checkPrerequisites();
    const passphrase = await setupPassphrase();
    const { supaUrl, supaKey } = await bootstrapCredentials(passphrase);
    await ensureClaudeAuth(passphrase);
    await ensureCodexAuth(passphrase);
    await installHooks();
    await registerSkillSync();
    await pullGlobalSync(passphrase);
    await mergeSettings();
    await setupApiKeys(passphrase);
    await setEnvVars();
    await installItachiWrapper();
    await testConnectivity();

    if (!HOOKS_ONLY) {
      await setupOrchestrator(supaUrl, supaKey);
    }

    log('\n========================================', 'green');
    log('  Setup Complete!', 'green');
    log('========================================\n', 'green');
    log('  Use "itachi" instead of "claude" for full system integration.');
    log('  All env vars are synced and persistent.');
    if (!HOOKS_ONLY) {
      log('  Test: Send \'/task <project> Hello world\' on Telegram');
    }
    log('');
  } catch (e) {
    log(`\nERROR: ${e.message}`, 'red');
    if (e.stack) log(e.stack, 'gray');
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
