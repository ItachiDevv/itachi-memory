#!/usr/bin/env node
// tools/session-watcher.mjs
// Real-time Claude Code session monitor — sends Telegram nudges on detected issues

import { readFileSync, statSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import https from 'https';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';
const BRAIN_API = process.env.BRAIN_API_URL || 'https://itachisbrainserver.online/api';
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const CHECK_INTERVAL_MS = 10_000;
const MIN_NUDGE_INTERVAL_MS = 120_000;

const watchedSessions = new Map();

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

async function checkGuardrails(text, project) {
  if (!BRAIN_API) return [];
  try {
    const res = await fetch(`${BRAIN_API}/memory/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text.substring(0, 200), project, category: 'guardrail', limit: 3 }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.memories || [])
      .filter(m => (m.similarity || 0) > 0.5)
      .map(m => m.summary || m.content);
  } catch {
    return [];
  }
}

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
    const lines = [`*Session Watcher Alert*`, `Project: \`${session.project}\``];
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
  }
}

async function tick() {
  const sessions = findActiveSessions();
  for (const session of sessions) {
    try { await tailSession(session); } catch (err) {
      console.error(`[watcher] Error tailing ${session.path}: ${err.message}`);
    }
  }
  for (const [path] of watchedSessions) {
    try {
      const stat = statSync(path);
      if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) watchedSessions.delete(path);
    } catch { watchedSessions.delete(path); }
  }
}

console.log(`[session-watcher] Starting — monitoring ${PROJECTS_DIR}`);
console.log(`[session-watcher] Telegram: ${TELEGRAM_BOT_TOKEN ? 'configured' : 'NOT configured'}`);
console.log(`[session-watcher] Brain API: ${BRAIN_API || 'NOT configured'}`);

tick();
setInterval(tick, CHECK_INTERVAL_MS);
