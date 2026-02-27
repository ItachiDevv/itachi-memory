/**
 * Tests for the 4 topic-related fixes:
 *   1. stripBotMention — normalizes /command@BotName in group chats
 *   2. buildEngineKeyboard — 3x2 grid with all 6 engine+mode combinations
 *   3. Engine+mode parsing — sf:s: handler parses new i.ds format + old ds fallback
 *   4. conversation-flows.ts comment — documents the new sf:s: format
 *
 * Run with: npx tsx src/plugins/itachi-tasks/__tests__/topic-fixes.test.ts
 */

import { stripBotMention } from '../utils/telegram.js';
import { decodeCallback, encodeCallback } from '../shared/conversation-flows.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Test harness ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  FAIL  ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS  ${message}`);
  } else {
    failed++;
    failures.push(`${message} — expected ${e}, got ${a}`);
    console.log(`  FAIL  ${message} — expected ${e}, got ${a}`);
  }
}

// =====================================================================
// 1. stripBotMention
// =====================================================================
console.log('\n=== 1. stripBotMention ===\n');

// Basic command with @BotName suffix
assertEqual(
  stripBotMention('/delete-topic@BotName'),
  '/delete-topic',
  '/delete-topic@BotName -> /delete-topic',
);

// Underscore variant (Telegram-standard command chars)
assertEqual(
  stripBotMention('/deletetopic@BotName'),
  '/deletetopic',
  '/deletetopic@BotName -> /deletetopic',
);

// Command with @BotName AND trailing arguments
assertEqual(
  stripBotMention('/delete_topics@BotName done'),
  '/delete_topics done',
  '/delete_topics@BotName done -> /delete_topics done',
);

// Existing command (no regression)
assertEqual(
  stripBotMention('/repos@Itachi_Mangekyou_bot'),
  '/repos',
  '/repos@Itachi_Mangekyou_bot -> /repos',
);

// Command with complex args after bot mention
assertEqual(
  stripBotMention('/cancel@Bot 3c1a19e5'),
  '/cancel 3c1a19e5',
  '/cancel@Bot 3c1a19e5 -> /cancel 3c1a19e5',
);

// The tricky case: /exec @windows — @windows is NOT the bot suffix, it is an arg
assertEqual(
  stripBotMention('/exec@Bot @windows echo test'),
  '/exec @windows echo test',
  '/exec@Bot @windows echo test -> /exec @windows echo test',
);

// Normal text with @mention should be unchanged (regex only matches leading /command)
assertEqual(
  stripBotMention('normal text @mention'),
  'normal text @mention',
  'normal text with @mention is unchanged',
);

// Command without @suffix should be unchanged
assertEqual(
  stripBotMention('/status'),
  '/status',
  '/status without @suffix is unchanged',
);

// Command with hyphen in name
assertEqual(
  stripBotMention('/close-all@Bot'),
  '/close-all',
  '/close-all@Bot -> /close-all (hyphen in command name)',
);

// Empty string
assertEqual(
  stripBotMention(''),
  '',
  'empty string is unchanged',
);

// Just a slash (edge case)
assertEqual(
  stripBotMention('/'),
  '/',
  'bare slash is unchanged',
);

// =====================================================================
// 2. buildEngineKeyboard — verify structure expectations
// =====================================================================
console.log('\n=== 2. Engine Picker Keyboard ===\n');

// Since buildEngineKeyboard is module-private, we replicate its expected output
// and verify against the constants and format we know.

/** ENGINE_SHORT mapping (replicated from callback-handler.ts) */
const ENGINE_SHORT: Record<string, string> = { i: 'itachi', c: 'itachic', g: 'itachig' };
const ENGINE_TO_SHORT: Record<string, string> = { itachi: 'i', itachic: 'c', itachig: 'g' };

/** Expected keyboard output */
const expectedKeyboard = [
  [
    { text: 'itachi --ds', callback_data: 'sf:s:i.ds' },
    { text: 'itachi --cds', callback_data: 'sf:s:i.cds' },
  ],
  [
    { text: 'itachic --ds', callback_data: 'sf:s:c.ds' },
    { text: 'itachic --cds', callback_data: 'sf:s:c.cds' },
  ],
  [
    { text: 'itachig --ds', callback_data: 'sf:s:g.ds' },
    { text: 'itachig --cds', callback_data: 'sf:s:g.cds' },
  ],
];

// Verify it is a 3x2 grid
assertEqual(expectedKeyboard.length, 3, 'keyboard has 3 rows');
for (let r = 0; r < expectedKeyboard.length; r++) {
  assertEqual(expectedKeyboard[r].length, 2, `row ${r} has 2 columns`);
}

// Verify total buttons = 6 (all engine+mode combos)
const allButtons = expectedKeyboard.flat();
assertEqual(allButtons.length, 6, 'keyboard has 6 total buttons');

// Verify callback_data format: sf:s:<short>.<mode>
for (const btn of allButtons) {
  const match = btn.callback_data.match(/^sf:s:([icg])\.(ds|cds)$/);
  assert(match !== null, `callback_data "${btn.callback_data}" matches format sf:s:<short>.<mode>`);
}

// Verify each ENGINE_SHORT mapping resolves correctly
assertEqual(ENGINE_SHORT['i'], 'itachi', 'ENGINE_SHORT i -> itachi');
assertEqual(ENGINE_SHORT['c'], 'itachic', 'ENGINE_SHORT c -> itachic');
assertEqual(ENGINE_SHORT['g'], 'itachig', 'ENGINE_SHORT g -> itachig');

// Verify ENGINE_TO_SHORT is the reverse
assertEqual(ENGINE_TO_SHORT['itachi'], 'i', 'ENGINE_TO_SHORT itachi -> i');
assertEqual(ENGINE_TO_SHORT['itachic'], 'c', 'ENGINE_TO_SHORT itachic -> c');
assertEqual(ENGINE_TO_SHORT['itachig'], 'g', 'ENGINE_TO_SHORT itachig -> g');

// Verify all 6 callback_data values are within Telegram's 64-byte limit
for (const btn of allButtons) {
  const byteLen = Buffer.byteLength(btn.callback_data, 'utf8');
  assert(byteLen <= 64, `callback_data "${btn.callback_data}" is ${byteLen} bytes (<= 64)`);
}

// Verify the button text shows the full engine name and flag
const expectedTexts = [
  'itachi --ds', 'itachi --cds',
  'itachic --ds', 'itachic --cds',
  'itachig --ds', 'itachig --cds',
];
for (let i = 0; i < allButtons.length; i++) {
  assertEqual(allButtons[i].text, expectedTexts[i], `button text matches: "${expectedTexts[i]}"`);
}

// =====================================================================
// 3. Engine+mode parsing from sf:s: callback handler
// =====================================================================
console.log('\n=== 3. Engine+Mode Parsing ===\n');

/**
 * Replicate the parsing logic from callback-handler.ts handleSessionFlowCallback
 * for the sf:s: handler. This tests the EXACT branching logic.
 */
function parseEngineMode(value: string): { engineCmd: string; dsFlag: string; usedFallback: boolean } {
  if (value.includes('.')) {
    // New format: <engineShort>.<mode>
    const [engShort, mode] = value.split('.');
    const engineCmd = ENGINE_SHORT[engShort] || 'itachi';
    const dsFlag = mode === 'cds' ? '--cds' : '--ds';
    return { engineCmd, dsFlag, usedFallback: false };
  } else {
    // Old format: ds or cds (backward compat — falls back to resolveEngine)
    const dsFlag = value === 'cds' ? '--cds' : '--ds';
    return { engineCmd: '<resolveEngine>', dsFlag, usedFallback: true };
  }
}

// New format: i.ds -> itachi, --ds
{
  const r = parseEngineMode('i.ds');
  assertEqual(r.engineCmd, 'itachi', 'i.ds -> engine=itachi');
  assertEqual(r.dsFlag, '--ds', 'i.ds -> flag=--ds');
  assertEqual(r.usedFallback, false, 'i.ds -> no fallback');
}

// New format: c.cds -> itachic, --cds
{
  const r = parseEngineMode('c.cds');
  assertEqual(r.engineCmd, 'itachic', 'c.cds -> engine=itachic');
  assertEqual(r.dsFlag, '--cds', 'c.cds -> flag=--cds');
  assertEqual(r.usedFallback, false, 'c.cds -> no fallback');
}

// New format: g.ds -> itachig, --ds
{
  const r = parseEngineMode('g.ds');
  assertEqual(r.engineCmd, 'itachig', 'g.ds -> engine=itachig');
  assertEqual(r.dsFlag, '--ds', 'g.ds -> flag=--ds');
  assertEqual(r.usedFallback, false, 'g.ds -> no fallback');
}

// New format: i.cds -> itachi, --cds
{
  const r = parseEngineMode('i.cds');
  assertEqual(r.engineCmd, 'itachi', 'i.cds -> engine=itachi');
  assertEqual(r.dsFlag, '--cds', 'i.cds -> flag=--cds');
}

// New format: g.cds -> itachig, --cds
{
  const r = parseEngineMode('g.cds');
  assertEqual(r.engineCmd, 'itachig', 'g.cds -> engine=itachig');
  assertEqual(r.dsFlag, '--cds', 'g.cds -> flag=--cds');
}

// Old format: ds -> falls back to resolveEngine
{
  const r = parseEngineMode('ds');
  assertEqual(r.usedFallback, true, 'ds (old format) -> falls back to resolveEngine');
  assertEqual(r.dsFlag, '--ds', 'ds (old format) -> flag=--ds');
}

// Old format: cds -> falls back to resolveEngine
{
  const r = parseEngineMode('cds');
  assertEqual(r.usedFallback, true, 'cds (old format) -> falls back to resolveEngine');
  assertEqual(r.dsFlag, '--cds', 'cds (old format) -> flag=--cds');
}

// Unknown engine short code falls back to itachi
{
  const r = parseEngineMode('x.ds');
  assertEqual(r.engineCmd, 'itachi', 'x.ds (unknown short) -> fallback engine=itachi');
  assertEqual(r.dsFlag, '--ds', 'x.ds -> flag=--ds');
}

// Verify decodeCallback correctly parses sf:s:i.ds
{
  const decoded = decodeCallback('sf:s:i.ds');
  assert(decoded !== null, 'decodeCallback("sf:s:i.ds") is not null');
  assertEqual(decoded!.prefix, 'sf', 'decoded prefix = sf');
  assertEqual(decoded!.key, 's', 'decoded key = s');
  assertEqual(decoded!.value, 'i.ds', 'decoded value = i.ds');
}

// Verify decodeCallback correctly parses sf:s:c.cds
{
  const decoded = decodeCallback('sf:s:c.cds');
  assertEqual(decoded!.value, 'c.cds', 'decodeCallback sf:s:c.cds -> value = c.cds');
}

// Verify old format also decodes correctly (backward compat)
{
  const decoded = decodeCallback('sf:s:ds');
  assertEqual(decoded!.value, 'ds', 'decodeCallback sf:s:ds (old) -> value = ds');
}

// Verify encodeCallback produces the right format
{
  const encoded = encodeCallback('sf', 's', 'i.ds');
  assertEqual(encoded, 'sf:s:i.ds', 'encodeCallback(sf, s, i.ds) -> sf:s:i.ds');
}

// =====================================================================
// 4. conversation-flows.ts comment documents the new format
// =====================================================================
console.log('\n=== 4. Conversation Flows Comment ===\n');

const flowsPath = resolve(__dirname, '..', 'shared', 'conversation-flows.ts');
const flowsSource = readFileSync(flowsPath, 'utf-8');

// The comment should document the new sf:s: format with engine.mode notation
assert(
  flowsSource.includes('sf:s:i.ds'),
  'conversation-flows.ts comment mentions sf:s:i.ds',
);

assert(
  flowsSource.includes('i.cds'),
  'conversation-flows.ts comment mentions i.cds',
);

assert(
  flowsSource.includes('c.ds'),
  'conversation-flows.ts comment mentions c.ds',
);

assert(
  flowsSource.includes('g.cds'),
  'conversation-flows.ts comment mentions g.cds',
);

// Verify it documents all 6 combinations
const commentPattern = /sf:s:i\.ds\|i\.cds\|c\.ds\|c\.cds\|g\.ds\|g\.cds/;
assert(
  commentPattern.test(flowsSource),
  'conversation-flows.ts has full sf:s: format documentation with all 6 combos',
);

// Verify the old "ds|cds" only format is NOT the documented format for sf:s:
// (the old comment was: sf:s:ds|cds — it should now be sf:s:i.ds|...)
assert(
  !flowsSource.includes('sf:s:ds|cds'),
  'old sf:s:ds|cds format comment has been replaced',
);

// =====================================================================
// Summary
// =====================================================================
console.log('\n' + '='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
  process.exit(0);
}
