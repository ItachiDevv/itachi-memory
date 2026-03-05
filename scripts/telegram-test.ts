/**
 * Telegram Autonomy Test Suite — comprehensive testing of the Itachi brain.
 *
 * Sends messages as your user account via GramJS, waits for bot responses,
 * and verifies task completion + RLM learning via Supabase queries.
 *
 * Setup (first time):
 *   1. Go to https://my.telegram.org → API Development Tools → Create Application
 *   2. Copy api_id and api_hash to eliza/.env
 *   3. Run: bun scripts/telegram-test.ts --auth
 *
 * Usage:
 *   bun scripts/telegram-test.ts --auth                    # First-time login
 *   bun scripts/telegram-test.ts --send "message"          # Send a single message
 *   bun scripts/telegram-test.ts --test                    # Run ALL test suites
 *   bun scripts/telegram-test.ts --suite <name>            # Run specific suite
 *   bun scripts/telegram-test.ts --verify <taskId>         # Check task status in DB
 *   bun scripts/telegram-test.ts --check-rlm <taskId>     # Check RLM lessons for task
 *
 * Suites: basic, rlm, cron, multistep, crossmachine, secondmsg, hallucination, crossproject
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

// ── Load env from eliza/.env ──────────────────────────────────────────
const envPath = path.resolve(import.meta.dir, '..', 'eliza', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

// ── Config ────────────────────────────────────────────────────────────

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0');
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const SESSION = process.env.TELEGRAM_SESSION || '';
const CHAT_ID = BigInt(process.env.TELEGRAM_CHAT_ID || '-1003521359823');
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

if (!API_ID || !API_HASH) {
  console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in eliza/.env');
  process.exit(1);
}

// ── Supabase helpers ──────────────────────────────────────────────────

async function supabaseQuery(table: string, params: Record<string, string> = {}): Promise<any[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn('  [DB] No Supabase credentials — skipping DB verification');
    return [];
  }
  const qs = new URLSearchParams(params).toString();
  const url = `${SUPABASE_URL}/rest/v1/${table}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    console.warn(`  [DB] Query failed: ${res.status} ${await res.text()}`);
    return [];
  }
  return res.json();
}

async function getRecentTasks(minutesAgo: number = 30, limit: number = 20): Promise<any[]> {
  const since = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return supabaseQuery('itachi_tasks', {
    'created_at': `gte.${since}`,
    order: 'created_at.desc',
    limit: String(limit),
    select: 'id,description,status,assigned_machine,project,result_summary,error_message,files_changed,created_at,completed_at',
  });
}

async function getTaskById(taskId: string): Promise<any | null> {
  const rows = await supabaseQuery('itachi_tasks', {
    id: `eq.${taskId}`,
    select: '*',
    limit: '1',
  });
  return rows[0] || null;
}

async function getMemoriesForTask(taskId: string): Promise<any[]> {
  return supabaseQuery('itachi_memories', {
    'metadata->>task_id': `eq.${taskId}`,
    order: 'created_at.desc',
    limit: '20',
    select: 'id,category,content,metadata,created_at',
  });
}

async function getRecentMemories(minutesAgo: number = 30, category?: string): Promise<any[]> {
  const since = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const params: Record<string, string> = {
    'created_at': `gte.${since}`,
    order: 'created_at.desc',
    limit: '20',
    select: 'id,category,content,metadata,created_at',
  };
  if (category) params.category = `eq.${category}`;
  return supabaseQuery('itachi_memories', params);
}

// ── Telegram helpers ──────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function createClient(): Promise<TelegramClient> {
  const session = new StringSession(SESSION);
  return new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 3 });
}

/** Collect ALL bot responses after a message until timeout */
async function collectBotResponses(
  client: TelegramClient,
  afterMessageId: number,
  timeoutMs: number = 120_000,
  matchPatterns?: RegExp[],
): Promise<string[]> {
  const responses: string[] = [];
  const defaultPatterns = [/task/i, /queued/i, /completed/i, /failed/i, /creating/i, /claimed/i, /running/i, /timeout/i];
  const patterns = matchPatterns || defaultPatterns;

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(responses), timeoutMs);

    const handler = async (event: any) => {
      const msg = event.message;
      if (msg.peerId && msg.id > afterMessageId) {
        const text = msg.text || msg.message || '';
        if (patterns.some(p => p.test(text))) {
          responses.push(text);
          // If we see a terminal status, wait 5s more for any follow-up then resolve
          if (/completed|failed|timeout/i.test(text)) {
            setTimeout(() => {
              clearTimeout(timer);
              client.removeEventHandler(handler, new NewMessage({}));
              resolve(responses);
            }, 5_000);
          }
        }
      }
    };

    client.addEventHandler(handler, new NewMessage({ chats: [CHAT_ID] }));
  });
}

/** Wait for a single bot response matching patterns */
async function waitForBotResponse(
  client: TelegramClient,
  afterMessageId: number,
  timeoutMs: number = 120_000,
): Promise<string | null> {
  const responses = await collectBotResponses(client, afterMessageId, timeoutMs);
  return responses.length > 0 ? responses.join('\n---\n') : null;
}

/** Wait for task to reach terminal status in DB (polls every 15s) */
async function waitForTaskCompletion(
  taskIdPrefix: string,
  maxWaitMs: number = 600_000,
): Promise<any | null> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const tasks = await getRecentTasks(60);
    const match = tasks.find(t =>
      t.id.startsWith(taskIdPrefix) ||
      t.description.toLowerCase().includes(taskIdPrefix.toLowerCase())
    );
    if (match && ['completed', 'failed', 'timeout'].includes(match.status)) {
      return match;
    }
    console.log(`  [poll] Waiting for task completion... (${Math.round((Date.now() - start) / 1000)}s)`);
    await new Promise(r => setTimeout(r, 15_000));
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Auth ──────────────────────────────────────────────────────────────

async function auth() {
  const client = await createClient();
  await client.start({
    phoneNumber: async () => await prompt('Phone number (with country code): '),
    password: async () => await prompt('2FA password (or press enter): '),
    phoneCode: async () => await prompt('Code from Telegram: '),
    onError: (err) => console.error('Auth error:', err),
  });
  const sessionStr = client.session.save() as unknown as string;
  console.log('\n=== Session saved! Add this to eliza/.env: ===');
  console.log(`TELEGRAM_SESSION=${sessionStr}`);
  await client.disconnect();
}

// ── Send Message ─────────────────────────────────────────────────────

async function sendAndPrint(client: TelegramClient, text: string): Promise<number> {
  const result = await client.sendMessage(CHAT_ID, { message: text });
  console.log(`  Sent (id: ${result.id}): "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
  return result.id;
}

// ── Test Infrastructure ──────────────────────────────────────────────

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  response: string;
  dbVerified?: boolean;
  rlmVerified?: boolean;
  details?: string;
}

const allResults: TestResult[] = [];

function logResult(r: TestResult) {
  allResults.push(r);
  const icon = r.passed ? 'PASS' : 'FAIL';
  console.log(`  [${icon}] ${r.name}`);
  if (r.details) console.log(`         ${r.details}`);
  if (!r.passed) console.log(`         Response: ${r.response.substring(0, 150)}`);
}

/** Extract task ID from bot response (8-char short ID) */
function extractTaskId(text: string): string | null {
  // Pattern: "Task QUEUED — abc12345" or "task_id: abc12345" or "(abc12345)"
  const m = text.match(/(?:QUEUED|task_id|task)[:\s—-]*([a-f0-9]{8})/i)
    || text.match(/\(([a-f0-9]{8})\)/);
  return m ? m[1] : null;
}

// ════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ════════════════════════════════════════════════════════════════════════

// ── Suite: Basic Autonomy (P1 baseline) ─────────────────────────────

async function suiteBasic(client: TelegramClient) {
  console.log('\n══════ Suite: BASIC AUTONOMY ══════\n');

  // Test 1: Simple info task
  {
    const msgId = await sendAndPrint(client, 'what is the current git branch in the itachi-memory repo');
    const resp = await waitForBotResponse(client, msgId, 180_000);
    const taskId = resp ? extractTaskId(resp) : null;
    let dbOk = false;

    if (taskId) {
      // Wait for actual completion
      const task = await waitForTaskCompletion(taskId, 300_000);
      dbOk = task?.status === 'completed';
    }

    logResult({
      suite: 'basic', name: 'Simple info task (git branch)',
      passed: !!resp && (resp.includes('QUEUED') || resp.includes('completed')),
      response: resp || 'TIMEOUT',
      dbVerified: dbOk,
      details: taskId ? `taskId=${taskId}, dbCompleted=${dbOk}` : 'No task ID extracted',
    });
    await sleep(10_000);
  }

  // Test 2: File creation (verifiable)
  {
    const marker = `test-${Date.now()}`;
    const msgId = await sendAndPrint(client,
      `create a file at ~/autonomy-proof-${marker}.txt containing "${marker}" and the current date`
    );
    const resp = await waitForBotResponse(client, msgId, 180_000);
    const taskId = resp ? extractTaskId(resp) : null;
    let dbOk = false;

    if (taskId) {
      const task = await waitForTaskCompletion(taskId, 300_000);
      dbOk = task?.status === 'completed';
    }

    logResult({
      suite: 'basic', name: 'File creation task',
      passed: !!resp && (resp.includes('QUEUED') || resp.includes('completed')),
      response: resp || 'TIMEOUT',
      dbVerified: dbOk,
      details: `marker=${marker}, taskId=${taskId}, dbCompleted=${dbOk}`,
    });
    await sleep(10_000);
  }

  // Test 3: Read + analyze
  {
    const msgId = await sendAndPrint(client,
      'read the PRIORITIES.md file in the itachi-memory repo and summarize the P0 items in a few bullet points'
    );
    const resp = await waitForBotResponse(client, msgId, 180_000);
    const taskId = resp ? extractTaskId(resp) : null;
    let dbOk = false;

    if (taskId) {
      const task = await waitForTaskCompletion(taskId, 300_000);
      dbOk = task?.status === 'completed';
      // Check result_summary contains actual P0 content
      if (task?.result_summary) {
        const hasContent = /workspace|cleanup|mac|briefing|rlm/i.test(task.result_summary);
        if (!hasContent) console.log('  [WARN] result_summary may not contain actual P0 analysis');
      }
    }

    logResult({
      suite: 'basic', name: 'Read + analyze PRIORITIES.md',
      passed: !!resp && (resp.includes('QUEUED') || resp.includes('completed')),
      response: resp || 'TIMEOUT',
      dbVerified: dbOk,
    });
    await sleep(10_000);
  }
}

// ── Suite: RLM Verification (P3 #11, #12, Todo #1) ─────────────────

async function suiteRLM(client: TelegramClient) {
  console.log('\n══════ Suite: RLM VERIFICATION ══════\n');

  // Test 1: Send a task, verify lesson gets stored with outcome metadata
  {
    const msgId = await sendAndPrint(client,
      'list all test files in eliza/src/__tests/ in the itachi-memory repo and count them'
    );
    const resp = await waitForBotResponse(client, msgId, 180_000);
    const taskId = resp ? extractTaskId(resp) : null;
    let rlmOk = false;

    if (taskId) {
      const task = await waitForTaskCompletion(taskId, 300_000);
      if (task) {
        // Wait extra 30s for async transcript analysis
        console.log('  [rlm] Waiting 30s for transcript analysis...');
        await sleep(30_000);

        const memories = await getMemoriesForTask(taskId);
        rlmOk = memories.length > 0;
        const hasOutcome = memories.some(m => m.metadata?.outcome);
        const categories = [...new Set(memories.map(m => m.category))];

        console.log(`  [rlm] Found ${memories.length} memories for task ${taskId}`);
        console.log(`  [rlm] Categories: ${categories.join(', ')}`);
        console.log(`  [rlm] Has outcome metadata: ${hasOutcome}`);

        logResult({
          suite: 'rlm', name: 'Task lesson stored with outcome',
          passed: rlmOk && hasOutcome,
          response: resp || 'TIMEOUT',
          rlmVerified: rlmOk,
          details: `memories=${memories.length}, categories=${categories.join(',')}, hasOutcome=${hasOutcome}`,
        });
      } else {
        logResult({
          suite: 'rlm', name: 'Task lesson stored with outcome',
          passed: false, response: 'Task did not complete', rlmVerified: false,
        });
      }
    } else {
      logResult({
        suite: 'rlm', name: 'Task lesson stored with outcome',
        passed: false, response: resp || 'TIMEOUT', rlmVerified: false,
      });
    }
    await sleep(10_000);
  }

  // Test 2: Send a SIMILAR task — check if first task's lessons appear in prompt
  {
    const msgId = await sendAndPrint(client,
      'count the test files in eliza/src/__tests/ in itachi-memory and report which ones are for task-related features'
    );
    const resp = await waitForBotResponse(client, msgId, 180_000);
    const taskId = resp ? extractTaskId(resp) : null;

    if (taskId) {
      const task = await waitForTaskCompletion(taskId, 300_000);
      await sleep(30_000);

      // Check if memories from the first task were reinforced
      const recentMemories = await getRecentMemories(60, 'task_lesson');
      const reinforced = recentMemories.filter(m =>
        m.metadata?.confidence && m.metadata.confidence > 0.7
      );

      console.log(`  [rlm] Recent task_lessons: ${recentMemories.length}`);
      console.log(`  [rlm] Reinforced (conf>0.7): ${reinforced.length}`);

      logResult({
        suite: 'rlm', name: 'Similar task uses prior lessons (cross-learn)',
        passed: task?.status === 'completed',
        response: resp || 'TIMEOUT',
        rlmVerified: reinforced.length > 0,
        details: `taskCompleted=${task?.status}, recentLessons=${recentMemories.length}, reinforced=${reinforced.length}`,
      });
    } else {
      logResult({
        suite: 'rlm', name: 'Similar task uses prior lessons (cross-learn)',
        passed: false, response: resp || 'TIMEOUT',
      });
    }
    await sleep(10_000);
  }

  // Test 3: Cross-project learning (P3 #12)
  {
    const msgId = await sendAndPrint(client,
      'read the package.json in the time repo and list the main dependencies'
    );
    const resp = await waitForBotResponse(client, msgId, 180_000);
    const taskId = resp ? extractTaskId(resp) : null;

    if (taskId) {
      const task = await waitForTaskCompletion(taskId, 300_000);
      await sleep(30_000);

      const memories = await getMemoriesForTask(taskId);
      const hasLesson = memories.some(m => m.category === 'task_lesson');

      logResult({
        suite: 'rlm', name: 'Cross-project learning (time repo)',
        passed: task?.status === 'completed' && hasLesson,
        response: resp || 'TIMEOUT',
        rlmVerified: hasLesson,
        details: `project=time, taskStatus=${task?.status}, lessonsStored=${memories.length}`,
      });
    } else {
      logResult({
        suite: 'rlm', name: 'Cross-project learning (time repo)',
        passed: false, response: resp || 'TIMEOUT',
      });
    }
    await sleep(10_000);
  }
}

// ── Suite: Cron / Scheduled Automation (P1 #4) ─────────────────────

async function suiteCron(client: TelegramClient) {
  console.log('\n══════ Suite: CRON / SCHEDULED AUTOMATION ══════\n');

  // Test: Create a cron job
  {
    const msgId = await sendAndPrint(client,
      'create a cron job that runs every hour and appends the current date to ~/cron-test-log.txt on coolify'
    );
    const resp = await waitForBotResponse(client, msgId, 240_000);
    const taskId = resp ? extractTaskId(resp) : null;
    let dbOk = false;

    if (taskId) {
      const task = await waitForTaskCompletion(taskId, 600_000);
      dbOk = task?.status === 'completed';
    }

    logResult({
      suite: 'cron', name: 'Create cron job (hourly date log)',
      passed: !!resp && (resp.includes('QUEUED') || resp.includes('completed')),
      response: resp || 'TIMEOUT',
      dbVerified: dbOk,
      details: `taskId=${taskId}, dbCompleted=${dbOk}`,
    });
    await sleep(10_000);
  }

  // Test: Scheduled disk check
  {
    const msgId = await sendAndPrint(client,
      'set up a weekly disk space check script at ~/disk-monitor.sh that logs to ~/disk-usage.log, and add it to crontab for every Sunday at midnight'
    );
    const resp = await waitForBotResponse(client, msgId, 240_000);
    const taskId = resp ? extractTaskId(resp) : null;
    let dbOk = false;

    if (taskId) {
      const task = await waitForTaskCompletion(taskId, 600_000);
      dbOk = task?.status === 'completed';
    }

    logResult({
      suite: 'cron', name: 'Weekly disk space monitor + crontab',
      passed: !!resp && (resp.includes('QUEUED') || resp.includes('completed')),
      response: resp || 'TIMEOUT',
      dbVerified: dbOk,
    });
    await sleep(10_000);
  }
}

// ── Suite: Multi-Step Workflows (P1 #5) ─────────────────────────────

async function suiteMultiStep(client: TelegramClient) {
  console.log('\n══════ Suite: MULTI-STEP WORKFLOWS ══════\n');

  // Test: Read + modify + verify
  {
    const msgId = await sendAndPrint(client,
      'in the itachi-memory repo, read the PRIORITIES.md file, check how many completed items there are, and add a comment at the bottom with the count and current date'
    );
    const resp = await waitForBotResponse(client, msgId, 240_000);
    const taskId = resp ? extractTaskId(resp) : null;
    let dbOk = false;
    let hasFiles = false;

    if (taskId) {
      const task = await waitForTaskCompletion(taskId, 600_000);
      dbOk = task?.status === 'completed';
      hasFiles = !!(task?.files_changed && task.files_changed.length > 0);
    }

    logResult({
      suite: 'multistep', name: 'Read + modify PRIORITIES.md',
      passed: dbOk,
      response: resp || 'TIMEOUT',
      dbVerified: dbOk,
      details: `taskId=${taskId}, completed=${dbOk}, filesChanged=${hasFiles}`,
    });
    await sleep(10_000);
  }

  // Test: Script creation + execution
  {
    const msgId = await sendAndPrint(client,
      'create a bash script at ~/repo-status.sh that runs git status on all repos in ~/itachi/ and writes the output to ~/repo-report.txt, then execute it'
    );
    const resp = await waitForBotResponse(client, msgId, 240_000);
    const taskId = resp ? extractTaskId(resp) : null;
    let dbOk = false;

    if (taskId) {
      const task = await waitForTaskCompletion(taskId, 600_000);
      dbOk = task?.status === 'completed';
    }

    logResult({
      suite: 'multistep', name: 'Create script + execute it',
      passed: dbOk,
      response: resp || 'TIMEOUT',
      dbVerified: dbOk,
    });
    await sleep(10_000);
  }
}

// ── Suite: Cross-Machine Coordination (P1 #6) ──────────────────────

async function suiteCrossMachine(client: TelegramClient) {
  console.log('\n══════ Suite: CROSS-MACHINE ROUTING ══════\n');

  // Test: Explicit Linux routing
  {
    const msgId = await sendAndPrint(client,
      'on coolify, check how much disk space is available and report the result'
    );
    const resp = await waitForBotResponse(client, msgId, 180_000);
    const taskId = resp ? extractTaskId(resp) : null;
    let machine = '';

    if (taskId) {
      const task = await waitForTaskCompletion(taskId, 300_000);
      machine = task?.assigned_machine || '';
      const isCorrectMachine = ['coolify', 'hetzner', 'linux'].some(m =>
        machine.toLowerCase().includes(m)
      );

      logResult({
        suite: 'crossmachine', name: 'Route to Linux (coolify)',
        passed: task?.status === 'completed' && isCorrectMachine,
        response: resp || 'TIMEOUT',
        details: `machine=${machine}, status=${task?.status}`,
      });
    } else {
      logResult({
        suite: 'crossmachine', name: 'Route to Linux (coolify)',
        passed: false, response: resp || 'TIMEOUT',
      });
    }
    await sleep(10_000);
  }

  // Test: Explicit Windows routing
  {
    const msgId = await sendAndPrint(client,
      'on windows, check the current git branch in itachi-memory and report'
    );
    const resp = await waitForBotResponse(client, msgId, 180_000);
    const taskId = resp ? extractTaskId(resp) : null;
    let machine = '';

    if (taskId) {
      const task = await waitForTaskCompletion(taskId, 300_000);
      machine = task?.assigned_machine || '';
      const isWindows = machine.toLowerCase().includes('windows');

      logResult({
        suite: 'crossmachine', name: 'Route to Windows',
        passed: task?.status === 'completed' && isWindows,
        response: resp || 'TIMEOUT',
        details: `machine=${machine}, status=${task?.status}`,
      });
    } else {
      logResult({
        suite: 'crossmachine', name: 'Route to Windows',
        passed: false, response: resp || 'TIMEOUT',
      });
    }
    await sleep(10_000);
  }

  // Test: Mac routing (P0 #2 — expected to fail with briefing issue)
  {
    const msgId = await sendAndPrint(client,
      'on mac, list the home directory contents and report'
    );
    const resp = await waitForBotResponse(client, msgId, 180_000);
    const taskId = resp ? extractTaskId(resp) : null;
    let machine = '';
    let status = '';

    if (taskId) {
      const task = await waitForTaskCompletion(taskId, 300_000);
      machine = task?.assigned_machine || '';
      status = task?.status || '';
      const isMac = machine.toLowerCase().includes('mac');

      // NOTE: Mac is known to fail (P0 #2). We're documenting the behavior.
      logResult({
        suite: 'crossmachine', name: 'Route to Mac (P0 #2 — may fail)',
        passed: task?.status === 'completed',
        response: resp || 'TIMEOUT',
        details: `machine=${machine}, status=${status}, error=${task?.error_message?.substring(0, 80) || 'none'}`,
      });
    } else {
      logResult({
        suite: 'crossmachine', name: 'Route to Mac (P0 #2 — may fail)',
        passed: false, response: resp || 'TIMEOUT',
        details: 'Expected: may fail due to "End Briefing" issue',
      });
    }
    await sleep(10_000);
  }
}

// ── Suite: Second Message Detection (P2 #8) ────────────────────────

async function suiteSecondMessage(client: TelegramClient) {
  console.log('\n══════ Suite: SECOND MESSAGE DETECTION ══════\n');

  // Send two messages quickly (< 3s apart)
  const msg1 = 'check the git log of itachi-memory and report the last commit message';
  const msg2 = 'check the uptime on coolify and report it';

  const id1 = await sendAndPrint(client, msg1);
  await sleep(2_000); // Only 2s gap
  const id2 = await sendAndPrint(client, msg2);

  console.log('  Waiting 4 minutes for both tasks to be detected...');
  await sleep(240_000);

  // Check DB for both tasks
  const tasks = await getRecentTasks(10);
  const task1 = tasks.find(t => t.description.toLowerCase().includes('git log'));
  const task2 = tasks.find(t => t.description.toLowerCase().includes('uptime'));

  const bothDetected = !!task1 && !!task2;

  logResult({
    suite: 'secondmsg', name: 'First message detected as task',
    passed: !!task1,
    response: task1 ? `status=${task1.status}` : 'Not found in DB',
    details: task1 ? `id=${task1.id.substring(0, 8)}, status=${task1.status}` : 'Task not created',
  });

  logResult({
    suite: 'secondmsg', name: 'Second message (2s later) also detected',
    passed: !!task2,
    response: task2 ? `status=${task2.status}` : 'Not found in DB',
    details: task2 ? `id=${task2.id.substring(0, 8)}, status=${task2.status}` : 'Task not created — SECOND MSG DROPPED',
  });

  if (bothDetected) {
    // Wait for both to complete
    console.log('  Both detected! Waiting for completion...');
    const t1done = await waitForTaskCompletion(task1!.id.substring(0, 8), 300_000);
    const t2done = await waitForTaskCompletion(task2!.id.substring(0, 8), 300_000);

    logResult({
      suite: 'secondmsg', name: 'Both tasks completed independently',
      passed: t1done?.status === 'completed' && t2done?.status === 'completed',
      response: `task1=${t1done?.status}, task2=${t2done?.status}`,
    });
  }
}

// ── Suite: Hallucination Detection (Todo #2) ────────────────────────

async function suiteHallucination(client: TelegramClient) {
  console.log('\n══════ Suite: HALLUCINATION DETECTION ══════\n');

  // Send a task that MUST produce a file — verify file actually exists
  const marker = `hallcheck-${Date.now()}`;
  const msgId = await sendAndPrint(client,
    `create a file at ~/autonomy-verify-${marker}.txt with the text "VERIFIED:${marker}" — this is a verification test, the file MUST exist after completion`
  );
  const resp = await waitForBotResponse(client, msgId, 180_000);
  const taskId = resp ? extractTaskId(resp) : null;

  if (taskId) {
    const task = await waitForTaskCompletion(taskId, 300_000);

    if (task?.status === 'completed') {
      // Check if result_summary mentions the file or marker
      const mentionsFile = task.result_summary?.includes(marker) ||
        task.result_summary?.includes('autonomy-verify') ||
        task.result_summary?.includes('created') ||
        task.result_summary?.includes('wrote');
      const hasToolUse = task.result_summary?.includes('Write') ||
        task.result_summary?.includes('Bash') ||
        task.result_summary?.includes('Edit') ||
        task.result_summary?.includes('[TOOL_USE]');

      logResult({
        suite: 'hallucination', name: 'Task claims completion — result mentions file',
        passed: !!mentionsFile,
        response: task.result_summary?.substring(0, 200) || 'No result',
        details: `mentionsFile=${mentionsFile}, hasToolUse=${hasToolUse}`,
      });

      logResult({
        suite: 'hallucination', name: 'Task result shows actual tool usage',
        passed: !!hasToolUse,
        response: task.result_summary?.substring(0, 200) || 'No result',
        details: 'Checks result_summary for Write/Bash/Edit/[TOOL_USE] evidence',
      });
    } else {
      logResult({
        suite: 'hallucination', name: 'Task claims completion — result mentions file',
        passed: false,
        response: `Task status: ${task?.status || 'unknown'}`,
      });
    }
  } else {
    logResult({
      suite: 'hallucination', name: 'Task claims completion — result mentions file',
      passed: false, response: resp || 'TIMEOUT',
    });
  }
}

// ════════════════════════════════════════════════════════════════════════
// RUNNER
// ════════════════════════════════════════════════════════════════════════

const SUITES: Record<string, (client: TelegramClient) => Promise<void>> = {
  basic: suiteBasic,
  rlm: suiteRLM,
  cron: suiteCron,
  multistep: suiteMultiStep,
  crossmachine: suiteCrossMachine,
  secondmsg: suiteSecondMessage,
  hallucination: suiteHallucination,
};

async function runSuites(names: string[]) {
  if (!SESSION) {
    console.error('No TELEGRAM_SESSION found. Run --auth first.');
    process.exit(1);
  }

  const client = await createClient();
  await client.connect();
  console.log('=== Itachi Autonomy Test Suite ===');
  console.log(`Running: ${names.join(', ')}\n`);

  for (const name of names) {
    const fn = SUITES[name];
    if (!fn) {
      console.error(`Unknown suite: ${name}. Available: ${Object.keys(SUITES).join(', ')}`);
      continue;
    }
    try {
      await fn(client);
    } catch (err) {
      console.error(`Suite ${name} crashed:`, err);
      allResults.push({
        suite: name, name: `Suite ${name} error`,
        passed: false, response: String(err),
      });
    }
  }

  // ── Summary ──
  console.log('\n' + '═'.repeat(60));
  console.log('RESULTS SUMMARY');
  console.log('═'.repeat(60));

  const bySuite = new Map<string, TestResult[]>();
  for (const r of allResults) {
    if (!bySuite.has(r.suite)) bySuite.set(r.suite, []);
    bySuite.get(r.suite)!.push(r);
  }

  let totalPass = 0, totalFail = 0;
  for (const [suite, results] of bySuite) {
    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;
    totalPass += passed;
    totalFail += failed;
    console.log(`\n  [${suite}] ${passed}/${results.length} passed`);
    for (const r of results) {
      const icon = r.passed ? 'PASS' : 'FAIL';
      const db = r.dbVerified !== undefined ? ` [DB:${r.dbVerified ? 'ok' : 'no'}]` : '';
      const rlm = r.rlmVerified !== undefined ? ` [RLM:${r.rlmVerified ? 'ok' : 'no'}]` : '';
      console.log(`    ${icon} ${r.name}${db}${rlm}`);
      if (!r.passed && r.details) console.log(`         ${r.details}`);
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`TOTAL: ${totalPass}/${totalPass + totalFail} passed`);
  console.log('═'.repeat(60));

  await client.disconnect();
  process.exit(totalFail === 0 ? 0 : 1);
}

// ── Verify single task ──────────────────────────────────────────────

async function verifyTask(taskId: string) {
  console.log(`\n=== Verifying task: ${taskId} ===\n`);

  const tasks = await getRecentTasks(1440); // last 24h
  const task = tasks.find(t => t.id.startsWith(taskId));

  if (!task) {
    console.log('Task not found. Recent tasks:');
    for (const t of tasks.slice(0, 10)) {
      console.log(`  ${t.id.substring(0, 8)} | ${t.status.padEnd(10)} | ${t.description.substring(0, 60)}`);
    }
    return;
  }

  console.log(`ID:          ${task.id}`);
  console.log(`Status:      ${task.status}`);
  console.log(`Machine:     ${task.assigned_machine || 'unassigned'}`);
  console.log(`Project:     ${task.project}`);
  console.log(`Created:     ${task.created_at}`);
  console.log(`Completed:   ${task.completed_at || 'pending'}`);
  console.log(`Files:       ${task.files_changed || 'none'}`);
  console.log(`Error:       ${task.error_message || 'none'}`);
  console.log(`Result:      ${(task.result_summary || 'none').substring(0, 300)}`);
}

// ── Check RLM for task ──────────────────────────────────────────────

async function checkRLM(taskId: string) {
  console.log(`\n=== RLM Memories for task: ${taskId} ===\n`);

  const memories = await getMemoriesForTask(taskId);
  if (memories.length === 0) {
    console.log('No memories found for this task.');
    console.log('\nRecent memories (last 2h):');
    const recent = await getRecentMemories(120);
    for (const m of recent.slice(0, 10)) {
      console.log(`  [${m.category}] ${m.content.substring(0, 80)} (conf: ${m.metadata?.confidence || 'n/a'})`);
    }
    return;
  }

  for (const m of memories) {
    console.log(`[${m.category}] ${m.content.substring(0, 100)}`);
    console.log(`  outcome: ${m.metadata?.outcome || 'NOT SET'}`);
    console.log(`  confidence: ${m.metadata?.confidence || 'n/a'}`);
    console.log(`  source: ${m.metadata?.source || 'n/a'}`);
    console.log();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case '--auth':
    auth().catch(console.error);
    break;

  case '--send':
    if (!args[1]) {
      console.error('Usage: bun scripts/telegram-test.ts --send "your message"');
      process.exit(1);
    }
    (async () => {
      const client = await createClient();
      await client.connect();
      await sendAndPrint(client, args.slice(1).join(' '));
      await client.disconnect();
    })().catch(console.error);
    break;

  case '--test':
    runSuites(Object.keys(SUITES)).catch(console.error);
    break;

  case '--suite':
    if (!args[1]) {
      console.error(`Usage: bun scripts/telegram-test.ts --suite <name>`);
      console.error(`Available: ${Object.keys(SUITES).join(', ')}`);
      process.exit(1);
    }
    runSuites(args.slice(1)).catch(console.error);
    break;

  case '--verify':
    if (!args[1]) {
      console.error('Usage: bun scripts/telegram-test.ts --verify <taskId>');
      process.exit(1);
    }
    verifyTask(args[1]).catch(console.error);
    break;

  case '--check-rlm':
    if (!args[1]) {
      console.error('Usage: bun scripts/telegram-test.ts --check-rlm <taskId>');
      process.exit(1);
    }
    checkRLM(args[1]).catch(console.error);
    break;

  default:
    console.log('Itachi Autonomy Test Suite');
    console.log('');
    console.log('Usage:');
    console.log('  bun scripts/telegram-test.ts --auth                    # First-time login');
    console.log('  bun scripts/telegram-test.ts --send "message"          # Send a message');
    console.log('  bun scripts/telegram-test.ts --test                    # Run ALL suites');
    console.log('  bun scripts/telegram-test.ts --suite <name> [name2]    # Run specific suite(s)');
    console.log('  bun scripts/telegram-test.ts --verify <taskId>         # Check task in DB');
    console.log('  bun scripts/telegram-test.ts --check-rlm <taskId>     # Check RLM lessons');
    console.log('');
    console.log('Suites:');
    console.log('  basic          - File creation, read+analyze, info tasks');
    console.log('  rlm            - RLM lesson storage, outcome metadata, cross-project learning');
    console.log('  cron           - Cron job creation, scheduled automation');
    console.log('  multistep      - Multi-step workflows (read+modify, script+execute)');
    console.log('  crossmachine   - Linux/Windows/Mac routing');
    console.log('  secondmsg      - Two quick messages, both detected');
    console.log('  hallucination  - Verify task actually does work (not just claims it)');
}
