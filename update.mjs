#!/usr/bin/env node
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { platform, homedir } from 'os';

const ROOT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const IS_WIN = platform() === 'win32';

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

// 1. Git pull
console.log('=== Pulling latest changes ===');
run('git pull');

// 2. Ensure bun is installed
if (!commandExists('bun')) {
  console.log('\n=== Installing bun ===');
  if (IS_WIN) {
    run('npm install -g bun');
  } else {
    run('curl -fsSL https://bun.sh/install | bash');
    // Add bun to PATH for this process
    const bunBin = join(homedir(), '.bun', 'bin');
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

// 5. Ensure pm2 is installed
if (!commandExists('pm2')) {
  console.log('\n=== Installing pm2 ===');
  run('npm install -g pm2');
}

// 6. Restart or start orchestrator in PM2
console.log('\n=== Restarting orchestrator ===');
try {
  run('pm2 restart itachi-orchestrator --update-env');
} catch {
  run(`pm2 start ${join(orchDir, 'dist', 'index.js')} --name itachi-orchestrator`);
}
run('pm2 save');

console.log('\n=== Done ===');
