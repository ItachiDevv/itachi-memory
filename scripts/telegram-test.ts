/**
 * Telegram Autonomy Test — sends messages as your user account and verifies bot responses.
 *
 * Setup (first time):
 *   1. Go to https://my.telegram.org → API Development Tools → Create Application
 *   2. Copy api_id and api_hash to .env.local:
 *        TELEGRAM_API_ID=12345678
 *        TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890
 *   3. Run: bun scripts/telegram-test.ts --auth
 *      (logs in, saves session string to .env.local as TELEGRAM_SESSION)
 *
 * Usage:
 *   bun scripts/telegram-test.ts --auth              # First-time login
 *   bun scripts/telegram-test.ts --send "message"    # Send a single message
 *   bun scripts/telegram-test.ts --test              # Run full autonomy test suite
 *   bun scripts/telegram-test.ts --verify <taskId>   # Check if a task completed
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
const CHAT_ID = BigInt(process.env.TELEGRAM_CHAT_ID || '-1003521359823'); // Itachi_bot General

if (!API_ID || !API_HASH) {
  console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in .env.local');
  console.error('Get them from https://my.telegram.org → API Development Tools');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────

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
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 3,
  });
  return client;
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
  console.log('\n=== Session saved! Add this to .env.local: ===');
  console.log(`TELEGRAM_SESSION=${sessionStr}`);
  console.log('\n(Never commit this value)');

  await client.disconnect();
}

// ── Send Message ─────────────────────────────────────────────────────

async function sendMessage(text: string) {
  if (!SESSION) {
    console.error('No TELEGRAM_SESSION found. Run --auth first.');
    process.exit(1);
  }

  const client = await createClient();
  await client.connect();

  const result = await client.sendMessage(CHAT_ID, { message: text });
  console.log(`Sent message (id: ${result.id}): ${text}`);

  await client.disconnect();
}

// ── Wait for Bot Response ────────────────────────────────────────────

async function waitForBotResponse(
  client: TelegramClient,
  afterMessageId: number,
  timeoutMs: number = 120_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);

    const handler = async (event: any) => {
      const msg = event.message;
      // Bot responses come from the same chat, after our message
      if (msg.peerId && msg.id > afterMessageId) {
        const text = msg.text || msg.message || '';
        // Look for task creation or completion messages from the bot
        if (text.includes('Task QUEUED') || text.includes('completed') || text.includes('failed') || text.includes('Creating')) {
          clearTimeout(timer);
          client.removeEventHandler(handler, new NewMessage({}));
          resolve(text);
        }
      }
    };

    client.addEventHandler(handler, new NewMessage({ chats: [CHAT_ID] }));
  });
}

// ── Full Autonomy Test ───────────────────────────────────────────────

interface TestCase {
  name: string;
  message: string;
  expectCompleted: boolean;
  timeout: number;
}

const TEST_CASES: TestCase[] = [
  {
    name: 'Simple info task',
    message: 'what is the current git branch in the itachi-memory repo',
    expectCompleted: true,
    timeout: 120_000,
  },
  {
    name: 'File creation task',
    message: 'create a file at ~/test-autonomy.txt with the current date and time',
    expectCompleted: true,
    timeout: 180_000,
  },
  {
    name: 'Script creation task',
    message: 'create a bash script at ~/disk-check.sh that reports disk usage for all mounted drives',
    expectCompleted: true,
    timeout: 180_000,
  },
  {
    name: 'Read + analyze task',
    message: 'read the PRIORITIES.md file in the itachi-memory repo and summarize the P0 items',
    expectCompleted: true,
    timeout: 180_000,
  },
];

async function runTests() {
  if (!SESSION) {
    console.error('No TELEGRAM_SESSION found. Run --auth first.');
    process.exit(1);
  }

  const client = await createClient();
  await client.connect();

  console.log('=== Telegram Autonomy Test Suite ===\n');

  const results: { name: string; passed: boolean; response: string }[] = [];

  for (const test of TEST_CASES) {
    console.log(`[TEST] ${test.name}`);
    console.log(`  Sending: "${test.message}"`);

    // Send message
    const sent = await client.sendMessage(CHAT_ID, { message: test.message });
    console.log(`  Message sent (id: ${sent.id})`);

    // Wait for bot to respond
    console.log(`  Waiting for bot response (timeout: ${test.timeout / 1000}s)...`);
    const response = await waitForBotResponse(client, sent.id, test.timeout);

    if (response) {
      const passed = test.expectCompleted
        ? response.includes('QUEUED') || response.includes('completed') || response.includes('Creating')
        : true;
      results.push({ name: test.name, passed, response: response.substring(0, 200) });
      console.log(`  ${passed ? 'PASS' : 'FAIL'}: ${response.substring(0, 100)}`);
    } else {
      results.push({ name: test.name, passed: false, response: 'TIMEOUT — no bot response' });
      console.log(`  FAIL: No bot response within ${test.timeout / 1000}s`);
    }

    // Wait between tests to avoid message batching issues
    console.log('  Waiting 10s before next test...\n');
    await new Promise(r => setTimeout(r, 10_000));
  }

  // Summary
  console.log('\n=== Results ===');
  const passed = results.filter(r => r.passed).length;
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} — ${r.name}`);
    if (!r.passed) console.log(`         ${r.response}`);
  }
  console.log(`\n${passed}/${results.length} passed`);

  await client.disconnect();
  process.exit(passed === results.length ? 0 : 1);
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
    sendMessage(args.slice(1).join(' ')).catch(console.error);
    break;
  case '--test':
    runTests().catch(console.error);
    break;
  default:
    console.log('Usage:');
    console.log('  bun scripts/telegram-test.ts --auth              # First-time login');
    console.log('  bun scripts/telegram-test.ts --send "message"    # Send a message');
    console.log('  bun scripts/telegram-test.ts --test              # Run autonomy test suite');
}
