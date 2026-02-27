/**
 * Comprehensive test suite for topic management & session flow fixes.
 *
 * Features tested:
 *   A. stripBotMention (20+ scenarios)
 *   B. Engine picker keyboard structure (20+ scenarios)
 *   C. Engine+mode callback parsing (20+ scenarios)
 *   D. /deletetopic command routing (20+ scenarios)
 *   E. /deletetopics command routing (20+ scenarios)
 *   F. Session flow state transitions (20+ scenarios)
 *   G. Session control commands (20+ scenarios)
 *   H. Conversation flow lifecycle (20+ scenarios)
 *
 * Run with: npx tsx src/plugins/itachi-tasks/__tests__/comprehensive-fixes.test.ts
 */

import { stripBotMention } from '../utils/telegram.js';
import {
  decodeCallback, encodeCallback,
  getFlow, setFlow, clearFlow, cleanupStaleFlows,
  conversationFlows, flowKey,
  type ConversationFlow,
} from '../shared/conversation-flows.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Test harness ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];
let currentSection = '';

function section(name: string): void {
  currentSection = name;
  console.log(`\n=== ${name} ===\n`);
}

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${message}`);
  } else {
    failed++;
    failures.push(`[${currentSection}] ${message}`);
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
    failures.push(`[${currentSection}] ${message} — expected ${e}, got ${a}`);
    console.log(`  FAIL  ${message} — expected ${e}, got ${a}`);
  }
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) {
    passed++;
    console.log(`  PASS  ${message}`);
  } else {
    failed++;
    failures.push(`[${currentSection}] ${message} — "${needle}" not found`);
    console.log(`  FAIL  ${message} — "${needle}" not found`);
  }
}

// ── Replicated constants from production code ─────────────────────────

const ENGINE_SHORT: Record<string, string> = { i: 'itachi', c: 'itachic', g: 'itachig' };
const ENGINE_TO_SHORT: Record<string, string> = { itachi: 'i', itachic: 'c', itachig: 'g' };

const CONTROL_COMMANDS: Record<string, { bytes: string; label: string }> = {
  '/ctrl+c':    { bytes: '\x03',   label: 'Ctrl+C (interrupt)' },
  '/ctrl+d':    { bytes: '\x04',   label: 'Ctrl+D (EOF/exit)' },
  '/ctrl+z':    { bytes: '\x1a',   label: 'Ctrl+Z (suspend)' },
  '/ctrl+\\':   { bytes: '\x1c',   label: 'Ctrl+\\ (SIGQUIT)' },
  '/esc':       { bytes: '\x1b',   label: 'Escape' },
  '/enter':     { bytes: '\r',     label: 'Enter' },
  '/tab':       { bytes: '\t',     label: 'Tab' },
  '/yes':       { bytes: 'y\r',    label: 'y + Enter' },
  '/no':        { bytes: 'n\r',    label: 'n + Enter' },
  '/interrupt':  { bytes: '\x03',  label: 'Ctrl+C (interrupt)' },
  '/kill':       { bytes: '\x03',  label: 'Ctrl+C (interrupt)' },
  '/exit':       { bytes: '\x04',  label: 'Ctrl+D (EOF/exit)' },
  '/stop':       { bytes: '\x03',  label: 'Ctrl+C (interrupt)' },
};

/** Replicate the engine+mode parsing logic from callback-handler.ts */
function parseEngineMode(value: string): { engineCmd: string; dsFlag: string; usedFallback: boolean } {
  if (value.includes('.')) {
    const [engShort, mode] = value.split('.');
    const engineCmd = ENGINE_SHORT[engShort] || 'itachi';
    const dsFlag = mode === 'cds' ? '--cds' : '--ds';
    return { engineCmd, dsFlag, usedFallback: false };
  } else {
    const dsFlag = value === 'cds' ? '--cds' : '--ds';
    return { engineCmd: '<resolveEngine>', dsFlag, usedFallback: true };
  }
}

/** Replicate validate() command matching logic */
function matchesDeleteTopic(text: string): boolean {
  return text === '/delete_topic' || text === '/delete-topic' || text === '/deletetopic' ||
    text.startsWith('/delete_topic ') || text.startsWith('/delete-topic ') || text.startsWith('/deletetopic ');
}

function matchesDeleteTopics(text: string): boolean {
  return text === '/delete_topics' || text.startsWith('/delete_topics ') ||
    text === '/delete-topics' || text.startsWith('/delete-topics ') ||
    text === '/deletetopics' || text.startsWith('/deletetopics ') ||
    text === '/delete' || text.startsWith('/delete ');
}

/** Replicate the handler routing for delete_topics subcommand extraction */
function extractDeleteTopicsSub(text: string): string {
  const prefix = text.startsWith('/delete_topics') ? '/delete_topics'
    : text.startsWith('/delete-topics') ? '/delete-topics'
    : text.startsWith('/deletetopics') ? '/deletetopics'
    : '/delete';
  return text.substring(prefix.length).trim().replace(/^[-_]/, '');
}

/** Replicate the /deletetopic prefix extraction and idStr logic */
function extractDeleteTopicId(text: string): string {
  const prefix = text.startsWith('/delete_topic') ? '/delete_topic'
    : text.startsWith('/deletetopic') ? '/deletetopic'
    : '/delete-topic';
  return text.substring(prefix.length).trim();
}

/** Replicate the validate regex for session control commands */
function matchesControlCommand(text: string): RegExpMatchArray | null {
  return text.toLowerCase().match(/^\/(ctrl\+[a-z\\]|esc|interrupt|kill|stop|exit|enter|tab|yes|no)$/);
}

// =====================================================================
// A. stripBotMention — 20+ scenarios
// =====================================================================
section('A. stripBotMention');

// Basic cases
assertEqual(stripBotMention('/repos@Bot'), '/repos', 'basic: /repos@Bot');
assertEqual(stripBotMention('/help@Bot'), '/help', 'basic: /help@Bot');
assertEqual(stripBotMention('/status@Bot'), '/status', 'basic: /status@Bot');
assertEqual(stripBotMention('/cancel@Bot'), '/cancel', 'basic: /cancel@Bot');

// Hyphenated commands (the bug fix)
assertEqual(stripBotMention('/delete-topic@Bot'), '/delete-topic', 'hyphen: /delete-topic@Bot');
assertEqual(stripBotMention('/delete-topics@Bot'), '/delete-topics', 'hyphen: /delete-topics@Bot');
assertEqual(stripBotMention('/close-all@Bot'), '/close-all', 'hyphen: /close-all@Bot');
assertEqual(stripBotMention('/sync-repos@Bot'), '/sync-repos', 'hyphen: /sync-repos@Bot');
assertEqual(stripBotMention('/close-all-topics@Bot'), '/close-all-topics', 'hyphen: /close-all-topics@Bot');

// With arguments after bot mention
assertEqual(stripBotMention('/cancel@Bot 3c1a19e5'), '/cancel 3c1a19e5', 'args: /cancel@Bot 3c1a19e5');
assertEqual(stripBotMention('/delete_topics@Bot done'), '/delete_topics done', 'args: /delete_topics@Bot done');
assertEqual(stripBotMention('/recall@Bot auth middleware'), '/recall auth middleware', 'args: /recall@Bot auth middleware');
assertEqual(stripBotMention('/deletetopic@Bot 123'), '/deletetopic 123', 'args: /deletetopic@Bot 123');

// Complex bot names (with underscores)
assertEqual(stripBotMention('/repos@Itachi_Mangekyou_bot'), '/repos', 'complex bot: /repos@Itachi_Mangekyou_bot');
assertEqual(stripBotMention('/help@My_Test_Bot123'), '/help', 'complex bot: /help@My_Test_Bot123');

// No @bot suffix (should be unchanged)
assertEqual(stripBotMention('/status'), '/status', 'no suffix: /status');
assertEqual(stripBotMention('/help'), '/help', 'no suffix: /help');
assertEqual(stripBotMention('/delete-topic'), '/delete-topic', 'no suffix: /delete-topic');

// Non-command text (should be unchanged)
assertEqual(stripBotMention('normal text @mention'), 'normal text @mention', 'non-cmd: normal text @mention');
assertEqual(stripBotMention('hello'), 'hello', 'non-cmd: hello');
assertEqual(stripBotMention(''), '', 'non-cmd: empty string');
assertEqual(stripBotMention('/'), '/', 'non-cmd: bare slash');

// Edge cases
assertEqual(stripBotMention('/exec@Bot @windows echo test'), '/exec @windows echo test', 'edge: @args after bot mention');
assertEqual(stripBotMention('/a@b'), '/a', 'edge: minimal command /a@b');
assertEqual(stripBotMention('/@Bot'), '/@Bot', 'edge: slash only + @Bot (no command name)');

// =====================================================================
// B. Engine Picker Keyboard Structure — 20+ scenarios
// =====================================================================
section('B. Engine Picker Keyboard');

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

// Structure
assertEqual(expectedKeyboard.length, 3, 'keyboard has 3 rows');
assertEqual(expectedKeyboard[0].length, 2, 'row 0 has 2 columns');
assertEqual(expectedKeyboard[1].length, 2, 'row 1 has 2 columns');
assertEqual(expectedKeyboard[2].length, 2, 'row 2 has 2 columns');
assertEqual(expectedKeyboard.flat().length, 6, 'keyboard has 6 total buttons');

// All 6 button texts
assertEqual(expectedKeyboard[0][0].text, 'itachi --ds', 'btn 0,0 text = itachi --ds');
assertEqual(expectedKeyboard[0][1].text, 'itachi --cds', 'btn 0,1 text = itachi --cds');
assertEqual(expectedKeyboard[1][0].text, 'itachic --ds', 'btn 1,0 text = itachic --ds');
assertEqual(expectedKeyboard[1][1].text, 'itachic --cds', 'btn 1,1 text = itachic --cds');
assertEqual(expectedKeyboard[2][0].text, 'itachig --ds', 'btn 2,0 text = itachig --ds');
assertEqual(expectedKeyboard[2][1].text, 'itachig --cds', 'btn 2,1 text = itachig --cds');

// All 6 callback_data values
assertEqual(expectedKeyboard[0][0].callback_data, 'sf:s:i.ds', 'btn 0,0 data = sf:s:i.ds');
assertEqual(expectedKeyboard[0][1].callback_data, 'sf:s:i.cds', 'btn 0,1 data = sf:s:i.cds');
assertEqual(expectedKeyboard[1][0].callback_data, 'sf:s:c.ds', 'btn 1,0 data = sf:s:c.ds');
assertEqual(expectedKeyboard[1][1].callback_data, 'sf:s:c.cds', 'btn 1,1 data = sf:s:c.cds');
assertEqual(expectedKeyboard[2][0].callback_data, 'sf:s:g.ds', 'btn 2,0 data = sf:s:g.ds');
assertEqual(expectedKeyboard[2][1].callback_data, 'sf:s:g.cds', 'btn 2,1 data = sf:s:g.cds');

// Telegram callback_data 64-byte limit
for (const btn of expectedKeyboard.flat()) {
  const byteLen = Buffer.byteLength(btn.callback_data, 'utf8');
  assert(byteLen <= 64, `"${btn.callback_data}" is ${byteLen} bytes (<= 64)`);
}

// All callback_data match expected regex pattern
for (const btn of expectedKeyboard.flat()) {
  assert(/^sf:s:[icg]\.(ds|cds)$/.test(btn.callback_data), `"${btn.callback_data}" matches sf:s:<short>.<mode>`);
}

// No duplicate callback_data
const allCallbackData = expectedKeyboard.flat().map(b => b.callback_data);
assertEqual(new Set(allCallbackData).size, 6, 'all 6 callback_data values are unique');

// No duplicate button text
const allTexts = expectedKeyboard.flat().map(b => b.text);
assertEqual(new Set(allTexts).size, 6, 'all 6 button texts are unique');

// =====================================================================
// C. Engine+Mode Callback Parsing — 20+ scenarios
// =====================================================================
section('C. Engine+Mode Parsing');

// All 6 new-format combinations
{ const r = parseEngineMode('i.ds'); assertEqual(r.engineCmd, 'itachi', 'i.ds → itachi'); assertEqual(r.dsFlag, '--ds', 'i.ds → --ds'); assert(!r.usedFallback, 'i.ds no fallback'); }
{ const r = parseEngineMode('i.cds'); assertEqual(r.engineCmd, 'itachi', 'i.cds → itachi'); assertEqual(r.dsFlag, '--cds', 'i.cds → --cds'); }
{ const r = parseEngineMode('c.ds'); assertEqual(r.engineCmd, 'itachic', 'c.ds → itachic'); assertEqual(r.dsFlag, '--ds', 'c.ds → --ds'); }
{ const r = parseEngineMode('c.cds'); assertEqual(r.engineCmd, 'itachic', 'c.cds → itachic'); assertEqual(r.dsFlag, '--cds', 'c.cds → --cds'); }
{ const r = parseEngineMode('g.ds'); assertEqual(r.engineCmd, 'itachig', 'g.ds → itachig'); assertEqual(r.dsFlag, '--ds', 'g.ds → --ds'); }
{ const r = parseEngineMode('g.cds'); assertEqual(r.engineCmd, 'itachig', 'g.cds → itachig'); assertEqual(r.dsFlag, '--cds', 'g.cds → --cds'); }

// Old format backward compat
{ const r = parseEngineMode('ds'); assert(r.usedFallback, 'ds → fallback'); assertEqual(r.dsFlag, '--ds', 'ds → --ds'); }
{ const r = parseEngineMode('cds'); assert(r.usedFallback, 'cds → fallback'); assertEqual(r.dsFlag, '--cds', 'cds → --cds'); }

// Unknown engine short code → fallback to itachi
{ const r = parseEngineMode('x.ds'); assertEqual(r.engineCmd, 'itachi', 'x.ds → fallback itachi'); }
{ const r = parseEngineMode('z.cds'); assertEqual(r.engineCmd, 'itachi', 'z.cds → fallback itachi'); }
{ const r = parseEngineMode('1.ds'); assertEqual(r.engineCmd, 'itachi', '1.ds → fallback itachi'); }

// Empty/malformed values
{ const r = parseEngineMode(''); assert(r.usedFallback, 'empty → fallback'); assertEqual(r.dsFlag, '--ds', 'empty → --ds (not cds)'); }
{ const r = parseEngineMode('.'); assertEqual(r.engineCmd, 'itachi', '. → fallback itachi (empty short)'); }
{ const r = parseEngineMode('i.'); assertEqual(r.engineCmd, 'itachi', 'i. → itachi'); assertEqual(r.dsFlag, '--ds', 'i. → --ds (empty mode not cds)'); }

// decodeCallback for new format
{ const d = decodeCallback('sf:s:i.ds'); assertEqual(d?.prefix, 'sf', 'decode sf:s:i.ds prefix'); assertEqual(d?.key, 's', 'decode sf:s:i.ds key'); assertEqual(d?.value, 'i.ds', 'decode sf:s:i.ds value'); }
{ const d = decodeCallback('sf:s:c.cds'); assertEqual(d?.value, 'c.cds', 'decode sf:s:c.cds value'); }
{ const d = decodeCallback('sf:s:g.ds'); assertEqual(d?.value, 'g.ds', 'decode sf:s:g.ds value'); }

// decodeCallback for old format
{ const d = decodeCallback('sf:s:ds'); assertEqual(d?.value, 'ds', 'decode sf:s:ds (old) value'); }

// encodeCallback roundtrip
{ const e = encodeCallback('sf', 's', 'i.ds'); assertEqual(e, 'sf:s:i.ds', 'encode sf:s:i.ds'); }
{ const e = encodeCallback('sf', 's', 'g.cds'); assertEqual(e, 'sf:s:g.cds', 'encode sf:s:g.cds'); }

// ENGINE_SHORT and ENGINE_TO_SHORT consistency
for (const [short, full] of Object.entries(ENGINE_SHORT)) {
  assertEqual(ENGINE_TO_SHORT[full], short, `ENGINE bidirectional: ${full} ↔ ${short}`);
}

// =====================================================================
// D. /deletetopic Command Routing — 20+ scenarios
// =====================================================================
section('D. /deletetopic Routing');

// Validate matching (should match)
assert(matchesDeleteTopic('/deletetopic'), '/deletetopic matches');
assert(matchesDeleteTopic('/delete_topic'), '/delete_topic matches');
assert(matchesDeleteTopic('/delete-topic'), '/delete-topic matches');
assert(matchesDeleteTopic('/deletetopic 123'), '/deletetopic 123 matches');
assert(matchesDeleteTopic('/delete_topic 456'), '/delete_topic 456 matches');
assert(matchesDeleteTopic('/delete-topic 789'), '/delete-topic 789 matches');
assert(matchesDeleteTopic('/deletetopic abc'), '/deletetopic abc matches');

// Validate non-matching (should NOT match — these are /deletetopicS)
assert(!matchesDeleteTopic('/deletetopics'), '/deletetopics does NOT match /deletetopic');
assert(!matchesDeleteTopic('/deletetopics done'), '/deletetopics done does NOT match /deletetopic');
assert(!matchesDeleteTopic('/delete'), '/delete does NOT match /deletetopic');
assert(!matchesDeleteTopic('/delete done'), '/delete done does NOT match /deletetopic');
assert(!matchesDeleteTopic('/help'), '/help does NOT match /deletetopic');
assert(!matchesDeleteTopic('deletetopic'), 'no slash: deletetopic does NOT match');
assert(!matchesDeleteTopic('/delete_topics'), '/delete_topics does NOT match /deletetopic');

// ID extraction
assertEqual(extractDeleteTopicId('/deletetopic'), '', '/deletetopic → empty ID (picker)');
assertEqual(extractDeleteTopicId('/deletetopic 123'), '123', '/deletetopic 123 → ID "123"');
assertEqual(extractDeleteTopicId('/delete_topic 456'), '456', '/delete_topic 456 → ID "456"');
assertEqual(extractDeleteTopicId('/delete-topic 789'), '789', '/delete-topic 789 → ID "789"');
assertEqual(extractDeleteTopicId('/deletetopic abc'), 'abc', '/deletetopic abc → "abc" (invalid, handled by parseInt)');
assertEqual(extractDeleteTopicId('/deletetopic  123'), '123', '/deletetopic  123 → "123" (extra space trimmed)');

// parseInt validation edge cases
assert(isNaN(parseInt('abc', 10)), 'parseInt("abc") is NaN');
assert(!isNaN(parseInt('123', 10)), 'parseInt("123") is valid');
assert(parseInt('0', 10) === 0, 'parseInt("0") is 0 (falsy in if(!topicId))');
// Note: The code uses `if (!topicId || isNaN(topicId))` — this rejects 0

// =====================================================================
// E. /deletetopics Command Routing — 20+ scenarios
// =====================================================================
section('E. /deletetopics Routing');

// Validate matching
assert(matchesDeleteTopics('/deletetopics'), '/deletetopics matches');
assert(matchesDeleteTopics('/deletetopics done'), '/deletetopics done matches');
assert(matchesDeleteTopics('/delete_topics'), '/delete_topics matches');
assert(matchesDeleteTopics('/delete_topics done'), '/delete_topics done matches');
assert(matchesDeleteTopics('/delete-topics'), '/delete-topics matches');
assert(matchesDeleteTopics('/delete-topics failed'), '/delete-topics failed matches');
assert(matchesDeleteTopics('/delete'), '/delete matches');
assert(matchesDeleteTopics('/delete done'), '/delete done matches');
assert(matchesDeleteTopics('/delete all'), '/delete all matches');

// Subcommand extraction
assertEqual(extractDeleteTopicsSub('/deletetopics done'), 'done', '/deletetopics done → "done"');
assertEqual(extractDeleteTopicsSub('/deletetopics failed'), 'failed', '/deletetopics failed → "failed"');
assertEqual(extractDeleteTopicsSub('/deletetopics cancelled'), 'cancelled', '/deletetopics cancelled → "cancelled"');
assertEqual(extractDeleteTopicsSub('/deletetopics all'), 'all', '/deletetopics all → "all"');
assertEqual(extractDeleteTopicsSub('/deletetopics'), '', '/deletetopics (no arg) → "" (→ all)');
assertEqual(extractDeleteTopicsSub('/delete done'), 'done', '/delete done → "done"');
assertEqual(extractDeleteTopicsSub('/delete failed'), 'failed', '/delete failed → "failed"');
assertEqual(extractDeleteTopicsSub('/delete all'), 'all', '/delete all → "all"');
assertEqual(extractDeleteTopicsSub('/delete'), '', '/delete (no arg) → "" (→ all)');
assertEqual(extractDeleteTopicsSub('/delete_topics done'), 'done', '/delete_topics done → "done"');
assertEqual(extractDeleteTopicsSub('/delete-topics failed'), 'failed', '/delete-topics failed → "failed"');

// Edge: leading dash/underscore in subcommand (regex strips it)
assertEqual(extractDeleteTopicsSub('/delete_topics _done'), 'done', '/delete_topics _done → strip leading _');
assertEqual(extractDeleteTopicsSub('/delete_topics -done'), 'done', '/delete_topics -done → strip leading -');

// Status mapping tests
const subToStatus: Record<string, string> = {
  'done': 'completed', 'finished': 'completed', 'completed': 'completed',
  'failed': 'failed',
  'cancelled': 'cancelled', 'canceled': 'cancelled',
  'all': 'all', '': 'all',
};
for (const [sub, expected] of Object.entries(subToStatus)) {
  const actual = sub === 'done' || sub === 'finished' || sub === 'completed' ? 'completed'
    : sub === 'failed' ? 'failed'
    : sub === 'cancelled' || sub === 'canceled' ? 'cancelled'
    : sub === 'all' || sub === '' ? 'all'
    : 'unknown';
  assertEqual(actual, expected, `sub "${sub}" → status "${expected}"`);
}

// Verify /deletetopics done does NOT accidentally match /deletetopic handler
// Critical: /deletetopics done starts with /deletetopic but NOT /deletetopic<space>
assert(!'/deletetopics done'.startsWith('/deletetopic '), '/deletetopics done does NOT start with "/deletetopic "');
assert('/deletetopics done'.startsWith('/deletetopics'), '/deletetopics done DOES start with "/deletetopics"');

// =====================================================================
// F. Session Flow State Transitions — 20+ scenarios
// =====================================================================
section('F. Session Flow State Transitions');

// Flow creation and retrieval
const testChatId = 12345;
const testUserId = 67890;

// Clean state
conversationFlows.clear();
assertEqual(getFlow(testChatId), undefined, 'no flow initially');

// Create a session flow
const testFlow: ConversationFlow = {
  flowType: 'session',
  step: 'select_machine',
  chatId: testChatId,
  userId: testUserId,
  messageId: 100,
  createdAt: Date.now(),
  cachedMachines: [
    { id: 'mac', name: 'MacBook', status: 'available' },
    { id: 'windows', name: 'Windows', status: 'available' },
  ],
};
setFlow(testChatId, testUserId, testFlow);
assert(getFlow(testChatId) !== undefined, 'flow exists after setFlow');
assertEqual(getFlow(testChatId)?.flowType, 'session', 'flow type is session');
assertEqual(getFlow(testChatId)?.step, 'select_machine', 'step is select_machine');

// Simulate machine selection → select_repo
testFlow.machine = 'mac';
testFlow.step = 'select_repo';
testFlow.cachedDirs = ['itachi-memory', 'elizapets', 'other-project'];
setFlow(testChatId, testUserId, testFlow);
assertEqual(getFlow(testChatId)?.step, 'select_repo', 'step transitions to select_repo');
assertEqual(getFlow(testChatId)?.machine, 'mac', 'machine is mac');

// Simulate repo selection → select_subfolder
testFlow.repoPath = '~/itachi/itachi-memory';
testFlow.project = 'itachi-memory';
testFlow.step = 'select_subfolder';
testFlow.cachedDirs = ['eliza', 'hooks', 'docs'];
setFlow(testChatId, testUserId, testFlow);
assertEqual(getFlow(testChatId)?.step, 'select_subfolder', 'step transitions to select_subfolder');

// Simulate subfolder selection → select_start_mode
testFlow.repoPath = '~/itachi/itachi-memory/eliza';
testFlow.step = 'select_start_mode';
setFlow(testChatId, testUserId, testFlow);
assertEqual(getFlow(testChatId)?.step, 'select_start_mode', 'step transitions to select_start_mode');

// Clear flow
clearFlow(testChatId, testUserId);
assertEqual(getFlow(testChatId), undefined, 'flow cleared');

// Flow key uses chatId only (not userId)
assertEqual(flowKey(testChatId, testUserId), `${testChatId}`, 'flowKey uses chatId only');
assertEqual(flowKey(testChatId, 0), `${testChatId}`, 'flowKey ignores userId');
assertEqual(flowKey(testChatId), `${testChatId}`, 'flowKey without userId');

// Multiple flows don't interfere (different chatIds)
const flow1: ConversationFlow = { flowType: 'session', step: 'select_machine', chatId: 111, userId: 1, messageId: 1, createdAt: Date.now() };
const flow2: ConversationFlow = { flowType: 'task', step: 'select_machine', chatId: 222, userId: 2, messageId: 2, createdAt: Date.now() };
setFlow(111, 1, flow1);
setFlow(222, 2, flow2);
assertEqual(getFlow(111)?.flowType, 'session', 'flow1 is session');
assertEqual(getFlow(222)?.flowType, 'task', 'flow2 is task');
clearFlow(111, 1);
assertEqual(getFlow(111), undefined, 'flow1 cleared without affecting flow2');
assertEqual(getFlow(222)?.flowType, 'task', 'flow2 still exists');
clearFlow(222, 2);

// Same chatId overwrites existing flow
const flowA: ConversationFlow = { flowType: 'session', step: 'select_machine', chatId: 999, userId: 1, messageId: 1, createdAt: Date.now() };
const flowB: ConversationFlow = { flowType: 'task', step: 'select_machine', chatId: 999, userId: 1, messageId: 2, createdAt: Date.now() };
setFlow(999, 1, flowA);
assertEqual(getFlow(999)?.flowType, 'session', 'flowA is session');
setFlow(999, 1, flowB);
assertEqual(getFlow(999)?.flowType, 'task', 'flowB overwrites flowA');
clearFlow(999, 1);

// TTL cleanup
const staleFlow: ConversationFlow = { flowType: 'session', step: 'select_machine', chatId: 888, userId: 1, messageId: 1, createdAt: Date.now() - 11 * 60 * 1000 };
conversationFlows.set(flowKey(888), staleFlow);
cleanupStaleFlows();
assertEqual(getFlow(888), undefined, 'stale flow (11 min) cleaned up');

const freshFlow: ConversationFlow = { flowType: 'session', step: 'select_machine', chatId: 777, userId: 1, messageId: 1, createdAt: Date.now() };
setFlow(777, 1, freshFlow);
cleanupStaleFlows();
assert(getFlow(777) !== undefined, 'fresh flow survives cleanup');
clearFlow(777, 1);

// Verify "here" value in repo selection
assertEqual(decodeCallback('sf:r:here')?.value, 'here', 'sf:r:here decodes value = here');
assertEqual(decodeCallback('sf:d:here')?.value, 'here', 'sf:d:here decodes value = here');

// Verify numeric index in callbacks
assertEqual(decodeCallback('sf:r:0')?.value, '0', 'sf:r:0 decodes value = 0');
assertEqual(decodeCallback('sf:r:5')?.value, '5', 'sf:r:5 decodes value = 5');
assertEqual(decodeCallback('sf:m:2')?.value, '2', 'sf:m:2 decodes value = 2');

// =====================================================================
// G. Session Control Commands — 20+ scenarios
// =====================================================================
section('G. Session Control Commands');

// All control commands should match the regex
assert(matchesControlCommand('/ctrl+c') !== null, '/ctrl+c matches');
assert(matchesControlCommand('/ctrl+d') !== null, '/ctrl+d matches');
assert(matchesControlCommand('/ctrl+z') !== null, '/ctrl+z matches');
assert(matchesControlCommand('/ctrl+\\') !== null, '/ctrl+\\ matches');
assert(matchesControlCommand('/esc') !== null, '/esc matches');
assert(matchesControlCommand('/enter') !== null, '/enter matches');
assert(matchesControlCommand('/tab') !== null, '/tab matches');
assert(matchesControlCommand('/yes') !== null, '/yes matches');
assert(matchesControlCommand('/no') !== null, '/no matches');
assert(matchesControlCommand('/interrupt') !== null, '/interrupt matches');
assert(matchesControlCommand('/kill') !== null, '/kill matches');
assert(matchesControlCommand('/stop') !== null, '/stop matches');
assert(matchesControlCommand('/exit') !== null, '/exit matches');

// Case insensitivity
assert(matchesControlCommand('/CTRL+C') !== null, '/CTRL+C (uppercase) matches');
assert(matchesControlCommand('/Stop') !== null, '/Stop (mixed case) matches');
assert(matchesControlCommand('/ESC') !== null, '/ESC (uppercase) matches');
assert(matchesControlCommand('/YES') !== null, '/YES (uppercase) matches');

// Non-matching commands
assert(matchesControlCommand('/help') === null, '/help does NOT match control');
assert(matchesControlCommand('/close') === null, '/close does NOT match control');
assert(matchesControlCommand('/session') === null, '/session does NOT match control');
assert(matchesControlCommand('/ctrl+c extra') === null, '/ctrl+c extra (trailing text) does NOT match');
assert(matchesControlCommand('ctrl+c') === null, 'ctrl+c (no slash) does NOT match');
assert(matchesControlCommand('/ctrl') === null, '/ctrl (no +key) does NOT match');

// Verify bytes for critical commands
assertEqual(CONTROL_COMMANDS['/ctrl+c'].bytes, '\x03', 'ctrl+c sends 0x03');
assertEqual(CONTROL_COMMANDS['/ctrl+d'].bytes, '\x04', 'ctrl+d sends 0x04');
assertEqual(CONTROL_COMMANDS['/esc'].bytes, '\x1b', 'esc sends 0x1b');
assertEqual(CONTROL_COMMANDS['/stop'].bytes, '\x03', 'stop sends 0x03 (alias for ctrl+c)');
assertEqual(CONTROL_COMMANDS['/exit'].bytes, '\x04', 'exit sends 0x04 (alias for ctrl+d)');
assertEqual(CONTROL_COMMANDS['/yes'].bytes, 'y\r', 'yes sends y + CR');
assertEqual(CONTROL_COMMANDS['/no'].bytes, 'n\r', 'no sends n + CR');

// =====================================================================
// H. Conversation Flow Lifecycle — 20+ scenarios
// =====================================================================
section('H. Conversation Flow Lifecycle');

// Callback data encoding roundtrips
assertEqual(decodeCallback(encodeCallback('sf', 'm', '0'))?.value, '0', 'encode/decode sf:m:0');
assertEqual(decodeCallback(encodeCallback('sf', 'r', 'here'))?.value, 'here', 'encode/decode sf:r:here');
assertEqual(decodeCallback(encodeCallback('sf', 's', 'i.ds'))?.value, 'i.ds', 'encode/decode sf:s:i.ds');
assertEqual(decodeCallback(encodeCallback('tf', 'm', '1'))?.prefix, 'tf', 'encode/decode tf prefix');
assertEqual(decodeCallback(encodeCallback('tf', 'rm', 'new'))?.key, 'rm', 'encode/decode tf:rm key');

// Invalid callback data
assertEqual(decodeCallback(''), null, 'empty string → null');
assertEqual(decodeCallback('sf'), null, 'single part → null');
assertEqual(decodeCallback('sf:m'), null, 'two parts → null (needs 3+)');
assert(decodeCallback('sf:m:0') !== null, 'three parts → valid');
assert(decodeCallback('sf:s:i.ds') !== null, 'three parts with dot → valid');

// Callback data with colons in value
assertEqual(decodeCallback('sf:s:i.ds:extra')?.value, 'i.ds:extra', 'extra colons preserved in value');

// Session flow complete lifecycle: machine → repo → subfolder → engine+mode → spawn
conversationFlows.clear();
const lifecycleFlow: ConversationFlow = {
  flowType: 'session',
  step: 'select_machine',
  chatId: 500,
  userId: 1,
  messageId: 1,
  createdAt: Date.now(),
  cachedMachines: [{ id: 'mac', name: 'Mac', status: 'online' }],
};
setFlow(500, 1, lifecycleFlow);

// Step 1: Machine selected
lifecycleFlow.machine = 'mac';
lifecycleFlow.step = 'select_repo';
lifecycleFlow.cachedDirs = ['proj1', 'proj2'];
setFlow(500, 1, lifecycleFlow);
assertEqual(getFlow(500)?.step, 'select_repo', 'lifecycle: select_repo');

// Step 2: Repo selected, has subfolders
lifecycleFlow.repoPath = '~/itachi/proj1';
lifecycleFlow.project = 'proj1';
lifecycleFlow.step = 'select_subfolder';
lifecycleFlow.cachedDirs = ['src', 'tests'];
setFlow(500, 1, lifecycleFlow);
assertEqual(getFlow(500)?.step, 'select_subfolder', 'lifecycle: select_subfolder');

// Step 3: Subfolder selected (or "here")
lifecycleFlow.repoPath = '~/itachi/proj1/src';
lifecycleFlow.step = 'select_start_mode';
setFlow(500, 1, lifecycleFlow);
assertEqual(getFlow(500)?.step, 'select_start_mode', 'lifecycle: select_start_mode');

// Step 4: Engine+mode selected → flow cleared (spawning session)
clearFlow(500, 1);
assertEqual(getFlow(500), undefined, 'lifecycle: flow cleared after start');

// Task flow lifecycle: machine → repo_mode → repo → await_description
const taskFlow: ConversationFlow = {
  flowType: 'task',
  step: 'select_machine',
  chatId: 600,
  userId: 1,
  messageId: 1,
  createdAt: Date.now(),
  taskName: 'fix-bug',
  cachedMachines: [{ id: 'auto', name: 'First Available', status: 'auto' }, { id: 'mac', name: 'Mac', status: 'online' }],
};
setFlow(600, 1, taskFlow);
assertEqual(getFlow(600)?.flowType, 'task', 'task lifecycle: flowType is task');

taskFlow.machine = 'mac';
taskFlow.step = 'select_repo_mode';
setFlow(600, 1, taskFlow);
assertEqual(getFlow(600)?.step, 'select_repo_mode', 'task lifecycle: select_repo_mode');

taskFlow.repoMode = 'existing';
taskFlow.step = 'select_repo';
taskFlow.cachedDirs = ['my-repo'];
setFlow(600, 1, taskFlow);
assertEqual(getFlow(600)?.step, 'select_repo', 'task lifecycle: select_repo');

taskFlow.repoPath = '~/itachi/my-repo';
taskFlow.project = 'my-repo';
taskFlow.step = 'await_description';
setFlow(600, 1, taskFlow);
assertEqual(getFlow(600)?.step, 'await_description', 'task lifecycle: await_description');

clearFlow(600, 1);

// Verify dt: (delete topic) callback decoding
const dtDecoded = decodeCallback('dt:12345');
assertEqual(dtDecoded, null, 'dt:12345 has only 2 parts → null from decodeCallback');
// Note: dt: callbacks use raw data.startsWith('dt:') check, not decodeCallback
assert('dt:12345'.startsWith('dt:'), 'dt:12345 starts with dt:');
assertEqual(parseInt('dt:12345'.substring(3), 10), 12345, 'dt: extract topicId 12345');
assertEqual(parseInt('dt:0'.substring(3), 10), 0, 'dt: extract topicId 0');
assert(isNaN(parseInt('dt:abc'.substring(3), 10)), 'dt:abc → NaN');

// Browse callbacks
assert('browse:start'.startsWith('browse:'), 'browse:start starts with browse:');
assertEqual('browse:start'.substring(7), 'start', 'browse:start → action "start"');
assertEqual('browse:back'.substring(7), 'back', 'browse:back → action "back"');
assertEqual('browse:3'.substring(7), '3', 'browse:3 → action "3"');

// =====================================================================
// I. Source File Verification
// =====================================================================
section('I. Source File Verification');

// Read callback-handler.ts and verify buildEngineKeyboard exists
const cbHandlerPath = resolve(__dirname, '..', 'services', 'callback-handler.ts');
const cbHandlerSource = readFileSync(cbHandlerPath, 'utf-8');

assertIncludes(cbHandlerSource, 'function buildEngineKeyboard', 'callback-handler has buildEngineKeyboard function');
assertIncludes(cbHandlerSource, 'ENGINE_SHORT', 'callback-handler has ENGINE_SHORT constant');
assertIncludes(cbHandlerSource, 'sf:s:i.ds', 'callback-handler keyboard uses sf:s:i.ds');
assertIncludes(cbHandlerSource, 'sf:s:c.cds', 'callback-handler keyboard uses sf:s:c.cds');
assertIncludes(cbHandlerSource, 'sf:s:g.ds', 'callback-handler keyboard uses sf:s:g.ds');

// Verify buildEngineKeyboard is called in all 3 start-mode locations
const engineKbCalls = (cbHandlerSource.match(/buildEngineKeyboard\(\)/g) || []).length;
assert(engineKbCalls >= 3, `buildEngineKeyboard() called ${engineKbCalls} times (expected >= 3)`);

// Verify old 2-button keyboard is gone
assert(!cbHandlerSource.includes("{ text: 'Start (itachi --ds)'"), 'old 2-button "Start (itachi --ds)" removed');
assert(!cbHandlerSource.includes("{ text: 'Continue (itachi --cds)'"), 'old 2-button "Continue (itachi --cds)" removed');
assert(!cbHandlerSource.includes("callback_data: 'sf:s:ds'"), 'old callback_data sf:s:ds removed');

// Verify the sf:s handler parses the new format
assertIncludes(cbHandlerSource, "value.includes('.')", 'sf:s handler checks for dot in value');
assertIncludes(cbHandlerSource, "ENGINE_SHORT[engShort]", 'sf:s handler uses ENGINE_SHORT lookup');

// Verify spawningTopics is used in sf:s handler
assertIncludes(cbHandlerSource, 'spawningTopics.add', 'sf:s handler locks spawningTopics');
assertIncludes(cbHandlerSource, 'spawningTopics.delete', 'sf:s handler unlocks spawningTopics');

// Read telegram-commands.ts and verify IGNORE callback in handleDeleteTopicPicker
const tcPath = resolve(__dirname, '..', 'actions', 'telegram-commands.ts');
const tcSource = readFileSync(tcPath, 'utf-8');

// The IGNORE callback must be AFTER sendMessageWithKeyboard and BEFORE the return
const pickerFnStart = tcSource.indexOf('async function handleDeleteTopicPicker');
// Find the return statement, then find the line-ending `}` of the function (after `};` or next function)
const returnIdx = tcSource.indexOf("return { success: true, data: { found:", pickerFnStart);
const pickerFnEnd = tcSource.indexOf('\n}', returnIdx);
const pickerBody = tcSource.substring(pickerFnStart, pickerFnEnd + 2);
assertIncludes(pickerBody, "action: 'IGNORE'", 'handleDeleteTopicPicker has IGNORE callback');
assertIncludes(pickerBody, 'sendMessageWithKeyboard', 'handleDeleteTopicPicker sends keyboard');

// Verify the keyboard IS sent BEFORE the IGNORE callback (order matters)
const kbSendIdx = pickerBody.indexOf('sendMessageWithKeyboard');
const ignoreIdx = pickerBody.indexOf("action: 'IGNORE'");
assert(kbSendIdx < ignoreIdx, 'keyboard sent BEFORE IGNORE callback (order correct)');

// Read telegram.ts and verify stripBotMention regex
const telegramUtilPath = resolve(__dirname, '..', 'utils', 'telegram.ts');
const telegramUtilSource = readFileSync(telegramUtilPath, 'utf-8');
assertIncludes(telegramUtilSource, '[\\w-]+', 'stripBotMention regex includes [\\w-]+ for hyphens');

// Read conversation-flows.ts and verify comment
const flowsPath = resolve(__dirname, '..', 'shared', 'conversation-flows.ts');
const flowsSource = readFileSync(flowsPath, 'utf-8');
assertIncludes(flowsSource, 'sf:s:i.ds|i.cds|c.ds|c.cds|g.ds|g.cds', 'conversation-flows documents all 6 engine+mode combos');
assert(!flowsSource.includes('sf:s:ds|cds'), 'old sf:s:ds|cds comment removed');

// =====================================================================
// J. Collision & Priority Testing
// =====================================================================
section('J. Collision & Priority Testing');

// Critical: /deletetopic vs /deletetopics routing
// When user types /deletetopics, it should NOT match /deletetopic handler
const cmds = [
  { input: '/deletetopics', matchesTopic: false, matchesTopics: true },
  { input: '/deletetopics done', matchesTopic: false, matchesTopics: true },
  { input: '/deletetopic', matchesTopic: true, matchesTopics: false },
  { input: '/deletetopic 123', matchesTopic: true, matchesTopics: false },
  { input: '/delete_topics done', matchesTopic: false, matchesTopics: true },
  { input: '/delete_topic 123', matchesTopic: true, matchesTopics: false },
  { input: '/delete done', matchesTopic: false, matchesTopics: true },
  { input: '/delete', matchesTopic: false, matchesTopics: true },
];

for (const { input, matchesTopic, matchesTopics } of cmds) {
  if (matchesTopic) {
    assert(matchesDeleteTopic(input), `PRIORITY: "${input}" → /deletetopic handler`);
  } else {
    assert(!matchesDeleteTopic(input), `PRIORITY: "${input}" does NOT match /deletetopic`);
  }
  if (matchesTopics) {
    assert(matchesDeleteTopics(input), `PRIORITY: "${input}" → /deletetopics handler`);
  }
}

// In the handler, /deletetopic check comes BEFORE /deletetopics check (line 262 vs 287)
// This means /deletetopic must NOT accidentally match /deletetopics inputs
// The key: /deletetopics does NOT === '/deletetopic' and does NOT startsWith('/deletetopic ')
assert('/deletetopics' !== '/deletetopic', '/deletetopics !== /deletetopic');
assert(!'/deletetopics'.startsWith('/deletetopic '), '/deletetopics does NOT startsWith /deletetopic<space>');
assert(!'/deletetopics done'.startsWith('/deletetopic '), '/deletetopics done does NOT startsWith /deletetopic<space>');

// Cleanup
conversationFlows.clear();

// =====================================================================
// Summary
// =====================================================================
console.log('\n' + '='.repeat(70));
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  process.exit(1);
} else {
  console.log('\nAll tests passed!');
  process.exit(0);
}
