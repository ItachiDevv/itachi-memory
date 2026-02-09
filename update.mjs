#!/usr/bin/env node
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { platform, homedir } from 'os';

const ROOT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const IS_WIN = platform() === 'win32';
const HOME = homedir();

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function commandExists(cmd) {
  try {
    execSync(IS_WIN ? `where ${cmd}` : `command -v ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

// 0. Preflight checks
const orchEnv = join(ROOT, 'orchestrator', '.env');
if (!existsSync(orchEnv)) {
  console.log('=== WARNING: orchestrator/.env not found ===');
  console.log('    Run "node install.mjs --full" first to configure the orchestrator.');
  console.log('    The orchestrator will NOT start without this file.');
  console.log('');
}

// 1. Git pull
console.log('=== Pulling latest changes ===');
run('git pull');

// 2. Ensure bun is installed (ElizaOS is a bun project)
if (!commandExists('bun')) {
  console.log('\n=== Installing bun ===');
  if (IS_WIN) {
    run('npm install -g bun');
  } else {
    run('curl -fsSL https://bun.sh/install | bash');
    const bunBin = join(HOME, '.bun', 'bin');
    process.env.PATH = `${bunBin}:${process.env.PATH}`;
  }
}

// 3. Build ElizaOS
console.log('\n=== Building ElizaOS ===');
const elizaDir = join(ROOT, 'eliza');
run('bun install', { cwd: elizaDir });
run('bun run build', { cwd: elizaDir });

// 4. Build Orchestrator
console.log('\n=== Building Orchestrator ===');
const orchDir = join(ROOT, 'orchestrator');
run('npm install', { cwd: orchDir });
run('npm run build', { cwd: orchDir });

// 5. Restart orchestrator in PM2 (if orchestrator/.env exists)
if (!existsSync(orchEnv)) {
  console.log('\n=== Skipping PM2 — orchestrator/.env missing ===');
  console.log('    Run "node install.mjs --full" to set up the orchestrator.');
} else {
  if (!commandExists('pm2')) {
    console.log('\n=== Installing pm2 ===');
    run('npm install -g pm2');
  }

  console.log('\n=== Restarting orchestrator ===');
  try {
    run('pm2 restart itachi-orchestrator --update-env');
  } catch {
    run(`pm2 start ${join(orchDir, 'dist', 'index.js')} --name itachi-orchestrator`);
  }
  run('pm2 save');
}

console.log('\n=== Done ===');
