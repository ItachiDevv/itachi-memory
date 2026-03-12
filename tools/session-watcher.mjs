#!/usr/bin/env node
// tools/session-watcher.mjs
// Cross-platform Claude Code session monitor
// Reports to Itachi brain (machine heartbeat + issue reporting) and Telegram alerts
// Works on: macOS (launchd), Linux (systemd), Windows (Task Scheduler)

import { readFileSync, statSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir, hostname, platform, cpus, totalmem, freemem } from 'os';
import https from 'https';
import http from 'http';

// --- Config: load from env or ~/.itachi-api-keys ---
function loadKeysFile() {
  const keysPath = join(homedir(), '.itachi-api-keys');
  if (!existsSync(keysPath)) return {};
  const kv = {};
  for (const line of readFileSync(keysPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Za-z_]\w*)=(.*)$/);
    if (m) kv[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return kv;
}

const keys = loadKeysFile();
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || keys.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID || keys.TELEGRAM_GROUP_CHAT_ID || '';
const BRAIN_API = process.env.BRAIN_API_URL || keys.ITACHI_API_URL
  ? (process.env.BRAIN_API_URL || keys.ITACHI_API_URL).replace(/\/?$/, '/api').replace(/\/api\/api$/, '/api')
  : 'https://itachisbrainserver.online/api';
const ITACHI_API_KEY = process.env.ITACHI_API_KEY || keys.ITACHI_API_KEY || '';
const MACHINE_ID = process.env.ITACHI_MACHINE_ID || keys.ITACHI_ORCHESTRATOR_ID || hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-');

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const CHECK_INTERVAL_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MIN_NUDGE_INTERVAL_MS = 120_000;

const watchedSessions = new Map();
let lastHeartbeat = 0;

// --- HTTP helper ---
function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path.startsWith('http') ? path : `${BRAIN_API}${path}`);
    const mod = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (ITACHI_API_KEY) headers['x-api-key'] = ITACHI_API_KEY;
    const req = mod.request(url, { method, headers, rejectUnauthorized: false }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// --- Brain integration ---
async function registerMachine() {
  try {
    await apiRequest('POST', '/machines/register', {
      machine_id: MACHINE_ID,
      display_name: hostname(),
      os: platform(),
      specs: {
        cpus: cpus().length,
        totalMemMB: Math.round(totalmem() / 1024 / 1024),
        arch: process.arch,
      },
    });
    console.log(`[watcher] Registered with brain as "${MACHINE_ID}"`);
  } catch (err) {
    console.error(`[watcher] Brain register failed: ${err.message}`);
  }
}

async function sendHeartbeat(activeSessions) {
  if (Date.now() - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeat = Date.now();
  try {
    await apiRequest('POST', '/machines/heartbeat', {
      machine_id: MACHINE_ID,
      active_tasks: activeSessions,
      watcher_meta: {
        uptime: process.uptime(),
        memFreeMB: Math.round(freemem() / 1024 / 1024),
        activeSessions,
        watchedFiles: watchedSessions.size,
      },
    });
  } catch (err) {
    console.error(`[watcher] Heartbeat failed: ${err.message}`);
  }
}

async function reportIssueToBrain(session, issues) {
  try {
    // Decode project name from Claude's encoded directory format
    const projectName = session.project.replace(/-/g, '/').replace(/^\//, '');
    await apiRequest('POST', '/memory/create', {
      project: projectName,
      category: 'watcher_alert',
      content: issues.map(i => `${i.type}: ${i.error || i.detail}`).join('\n'),
      summary: `Session watcher detected ${issues.length} issue(s) on ${MACHINE_ID}`,
      metadata: {
        machine_id: MACHINE_ID,
        session_id: session.sessionId,
        issues,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error(`[watcher] Brain report failed: ${err.message}`);
  }
}

// --- Telegram ---
function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(`[watcher] Would nudge: ${text.substring(0, 100)}`);
    return;
  }
  const payload = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'Markdown',
    disable_notification: false,
  });
  const url = new URL(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`);
  const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  req.on('error', (err) => console.error(`[watcher] Telegram error: ${err.message}`));
  req.write(payload);
  req.end();
}

// --- Guardrail check via brain ---
async function checkGuardrails(text, project) {
  if (!BRAIN_API) return [];
  try {
    const res = await apiRequest('POST', '/memory/search', {
      query: text.substring(0, 200), project, category: 'guardrail', limit: 3,
    });
    return (res.memories || [])
      .filter(m => (m.similarity || 0) > 0.5)
      .map(m => m.summary || m.content);
  } catch {
    return [];
  }
}

// --- Session parsing ---
function parseTurns(jsonlChunk) {
  const turns = [];
  for (const line of jsonlChunk.split('\n')) {
    if (!line.trim()) continue;
    try { turns.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return turns;
}

function detectIssues(turns, sessionState) {
  const issues = [];
  for (const turn of turns) {
    const text = (turn.message?.content || turn.content || '').toString().toLowerCase();
    const errorPatterns = [
      /error\s*ts\d+/g,
      /error:\s+(.{10,60})/g,
      /failed\s+to\s+/g,
      /command\s+failed/g,
      /ENOENT|EACCES|EPERM/g,
    ];
    for (const pattern of errorPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        for (const match of matches) {
          sessionState.errors.push(match);
          sessionState.errorCount++;
        }
      }
    }
    const errorFreq = {};
    for (const err of sessionState.errors.slice(-20)) {
      errorFreq[err] = (errorFreq[err] || 0) + 1;
    }
    for (const [err, count] of Object.entries(errorFreq)) {
      if (count >= 3) {
        issues.push({ type: 'stuck_loop', error: err, count });
      }
    }
    if (/rm\s+-rf\s+[/~]/.test(text)) {
      issues.push({ type: 'dangerous_command', detail: 'rm -rf on root or home directory' });
    }
    if (/force.push|push.*--force/.test(text)) {
      issues.push({ type: 'dangerous_command', detail: 'force push detected' });
    }
    if (/drop\s+table|truncate\s+table/i.test(text)) {
      issues.push({ type: 'dangerous_command', detail: 'destructive SQL operation' });
    }
  }
  return issues;
}

function findActiveSessions() {
  const sessions = [];
  try {
    const projectDirs = readdirSync(PROJECTS_DIR, { withFileTypes: true });
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      const projectPath = join(PROJECTS_DIR, dir.name);
      try {
        const files = readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const fullPath = join(projectPath, file);
          try {
            const stat = statSync(fullPath);
            if (Date.now() - stat.mtimeMs < 5 * 60 * 1000) {
              sessions.push({
                path: fullPath,
                project: dir.name,
                size: stat.size,
                sessionId: basename(file, '.jsonl'),
              });
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch { /* projects dir doesn't exist */ }
  return sessions;
}

async function tailSession(session) {
  const state = watchedSessions.get(session.path) || {
    offset: Math.max(0, session.size - 5000),
    lastNudge: 0,
    errorCount: 0,
    errors: [],
  };
  watchedSessions.set(session.path, state);

  let currentSize;
  try { currentSize = statSync(session.path).size; } catch { return; }
  if (currentSize <= state.offset) return;

  const fd = readFileSync(session.path, 'utf-8');
  const newData = fd.substring(state.offset);
  state.offset = currentSize;
  if (!newData.trim()) return;

  const turns = parseTurns(newData);
  if (turns.length === 0) return;

  const issues = detectIssues(turns, state);
  const recentText = turns.map(t => (t.message?.content || t.content || '').toString()).join(' ').substring(0, 500);
  const guardrailHits = await checkGuardrails(recentText, session.project);

  const allIssues = [...issues];
  for (const g of guardrailHits) {
    allIssues.push({ type: 'guardrail_match', detail: g });
  }

  if (allIssues.length > 0 && Date.now() - state.lastNudge > MIN_NUDGE_INTERVAL_MS) {
    state.lastNudge = Date.now();
    const lines = [`*Session Watcher Alert* (${MACHINE_ID})`, `Project: \`${session.project}\``];
    const seen = new Set();
    for (const issue of allIssues.slice(0, 5)) {
      const key = `${issue.type}:${issue.error || issue.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (issue.type === 'stuck_loop') lines.push(`  Stuck loop: \`${issue.error}\` (${issue.count}x)`);
      else if (issue.type === 'dangerous_command') lines.push(`  Dangerous: ${issue.detail}`);
      else if (issue.type === 'guardrail_match') lines.push(`  Guardrail: ${issue.detail}`);
    }
    sendTelegram(lines.join('\n'));
    // Also report to brain for learning
    await reportIssueToBrain(session, allIssues);
  }
}

async function tick() {
  const sessions = findActiveSessions();

  // Heartbeat to brain with active session count
  await sendHeartbeat(sessions.length);

  for (const session of sessions) {
    try { await tailSession(session); } catch (err) {
      console.error(`[watcher] Error tailing ${session.path}: ${err.message}`);
    }
  }
  // Cleanup stale sessions (inactive >10 min)
  for (const [path] of watchedSessions) {
    try {
      const stat = statSync(path);
      if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) watchedSessions.delete(path);
    } catch { watchedSessions.delete(path); }
  }
}

// --- Startup ---
console.log(`[session-watcher] Starting — monitoring ${PROJECTS_DIR}`);
console.log(`[session-watcher] Machine: ${MACHINE_ID} (${platform()})`);
console.log(`[session-watcher] Brain API: ${BRAIN_API}`);
console.log(`[session-watcher] Telegram: ${TELEGRAM_BOT_TOKEN ? 'configured' : 'NOT configured'}`);

registerMachine().then(() => {
  tick();
  setInterval(tick, CHECK_INTERVAL_MS);
});
