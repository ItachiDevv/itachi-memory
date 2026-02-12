/**
 * E2E test: CREATE_TASK handler against real Supabase.
 * Tests the exact screenshot failure scenario:
 * "Yeah that would be great, can you do that?" with conversation context.
 *
 * Run: node test-e2e-create-task.mjs
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Import the actual action
const { createTaskAction } = await import('./src/plugins/itachi-tasks/actions/create-task.ts');

// IDs of tasks we create so we can clean up
const createdTaskIds = [];

// Build a runtime that uses real Supabase for task creation
function buildRuntime() {
  return {
    getSetting: (key) => {
      const settings = {
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        TELEGRAM_GROUP_CHAT_ID: '0',
      };
      return settings[key] || process.env[key] || '';
    },
    getService: (name) => {
      if (name === 'itachi-tasks') return taskServiceProxy;
      return null;
    },
    // Mock useModel to simulate LLM responses
    useModel: async (_type, opts) => {
      const prompt = typeof opts === 'string' ? opts : opts?.prompt || '';
      console.log('  [LLM] Prompt snippet:', prompt.substring(0, 120).replace(/\n/g, ' '));

      // Simulate what a real LLM would return given the conversation context
      if (prompt.includes('lotitachi') && prompt.includes('elizapets')) {
        const result = JSON.stringify([
          { project: 'lotitachi', description: 'Scaffold reusable Remotion compositions for demo videos' },
          { project: 'elizapets', description: 'Scaffold reusable Remotion compositions for demo videos' },
        ]);
        console.log('  [LLM] Response:', result);
        return result;
      }
      if (prompt.includes('lotitachi')) {
        const result = JSON.stringify([
          { project: 'lotitachi', description: 'Scaffold Remotion demo page' },
        ]);
        console.log('  [LLM] Response:', result);
        return result;
      }
      console.log('  [LLM] Response: []');
      return '[]';
    },
    logger: {
      info: (...args) => console.log('  [info]', ...args),
      warn: (...args) => console.warn('  [warn]', ...args),
      error: (...args) => console.error('  [error]', ...args),
    },
  };
}

// Real task service that writes to Supabase
const taskServiceProxy = {
  createTask: async (params) => {
    console.log('  [Supabase] Creating task:', params.project, '-', params.description);
    const { data, error } = await supabase
      .from('itachi_tasks')
      .insert({
        description: params.description,
        project: params.project,
        telegram_chat_id: params.telegram_chat_id || 0,
        telegram_user_id: params.telegram_user_id || 0,
        status: 'queued',
      })
      .select()
      .single();

    if (error) throw error;
    createdTaskIds.push(data.id);
    console.log('  [Supabase] Task created:', data.id.substring(0, 8));
    return data;
  },
  getQueuedCount: async () => {
    const { count } = await supabase
      .from('itachi_tasks')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'queued');
    return count || 0;
  },
  getMergedRepos: async () => {
    const { data } = await supabase
      .from('project_registry')
      .select('name, repo_url')
      .eq('active', true)
      .order('name');
    return data || [];
  },
};

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

async function cleanup() {
  if (createdTaskIds.length > 0) {
    console.log(`\nCleaning up ${createdTaskIds.length} test task(s)...`);
    for (const id of createdTaskIds) {
      await supabase.from('itachi_tasks').delete().eq('id', id);
    }
    console.log('Cleanup done.');
  }
}

// ============================================================
// TEST 1: /task command creates real task in Supabase
// ============================================================
async function test1_slashCommand() {
  console.log('\n=== TEST 1: /task lotitachi Scaffold Remotion demo page ===');

  const runtime = buildRuntime();
  const msg = {
    content: {
      text: '/task lotitachi Scaffold Remotion demo page',
      telegram_user_id: 123,
      telegram_chat_id: 456,
    },
  };

  let callbackText = '';
  const callback = async (r) => { callbackText = r.text; };
  const result = await createTaskAction.handler(runtime, msg, undefined, undefined, callback);

  assert(result.success === true, 'handler returns success');
  assert(callbackText.includes('Task queued!'), 'callback says "Task queued!"');
  assert(callbackText.includes('lotitachi'), 'callback mentions project name');

  // Verify in Supabase
  const taskId = createdTaskIds[createdTaskIds.length - 1];
  const { data } = await supabase.from('itachi_tasks').select('*').eq('id', taskId).single();
  assert(data !== null, 'task exists in Supabase');
  assert(data?.project === 'lotitachi', `project is "lotitachi" (got "${data?.project}")`);
  assert(data?.description === 'Scaffold Remotion demo page', 'description matches');
  assert(data?.status === 'queued', 'status is "queued"');
}

// ============================================================
// TEST 2: SCREENSHOT SCENARIO — contextual confirmation creates 2 tasks
// ============================================================
async function test2_screenshotScenario() {
  console.log('\n=== TEST 2: "Yeah that would be great, can you do that?" (SCREENSHOT SCENARIO) ===');

  const runtime = buildRuntime();
  const msg = {
    content: {
      text: 'Yeah that would be great, can you do that?',
      telegram_user_id: 123,
      telegram_chat_id: 456,
    },
  };
  const state = {
    data: {
      recentMessages: [
        { role: 'user', content: 'Using remotion for making demos for lotitachi and elizapets' },
        { role: 'assistant', content: 'Nice — Remotion is solid for programmatic video creation. I could queue up tasks to scaffold out reusable Remotion compositions. Want to offload any of that setup work?' },
        { role: 'user', content: 'Yeah that would be great, can you do that?' },
      ],
    },
  };

  let callbackText = '';
  const callback = async (r) => { callbackText = r.text; };
  const result = await createTaskAction.handler(runtime, msg, state, undefined, callback);

  assert(result.success === true, 'handler returns success');
  assert(createdTaskIds.length >= 3, `created 2+ tasks total (have ${createdTaskIds.length})`);

  // Check the last 2 tasks
  const task1Id = createdTaskIds[createdTaskIds.length - 2];
  const task2Id = createdTaskIds[createdTaskIds.length - 1];

  const { data: t1 } = await supabase.from('itachi_tasks').select('*').eq('id', task1Id).single();
  const { data: t2 } = await supabase.from('itachi_tasks').select('*').eq('id', task2Id).single();

  assert(t1?.project === 'lotitachi', `task 1 project is "lotitachi" (got "${t1?.project}")`);
  assert(t2?.project === 'elizapets', `task 2 project is "elizapets" (got "${t2?.project}")`);
  assert(t1?.description.includes('Remotion'), 'task 1 description mentions Remotion');
  assert(t2?.description.includes('Remotion'), 'task 2 description mentions Remotion');
  assert(t1?.status === 'queued', 'task 1 status is "queued"');
  assert(t2?.status === 'queued', 'task 2 status is "queued"');

  assert(callbackText.includes('2 tasks queued'), `callback says "2 tasks queued" (got: "${callbackText.substring(0, 80)}")`);
  assert(callbackText.includes('lotitachi'), 'callback mentions lotitachi');
  assert(callbackText.includes('elizapets'), 'callback mentions elizapets');
}

// ============================================================
// TEST 3: validate() accepts contextual message
// ============================================================
async function test3_validateContextual() {
  console.log('\n=== TEST 3: validate("Yeah that would be great") returns true ===');

  const runtime = buildRuntime();
  const msg = { content: { text: 'Yeah that would be great, can you do that?' } };
  const result = await createTaskAction.validate(runtime, msg);
  assert(result === true, 'validate() returns true when task service is available');
}

// ============================================================
// TEST 4: validate() returns false without task service
// ============================================================
async function test4_validateNoService() {
  console.log('\n=== TEST 4: validate() returns false without task service ===');

  const runtime = { ...buildRuntime(), getService: () => null };
  const msg = { content: { text: 'Yeah that would be great' } };
  const result = await createTaskAction.validate(runtime, msg);
  assert(result === false, 'validate() returns false when no task service');
}

// ============================================================
// RUN ALL TESTS
// ============================================================
try {
  await test3_validateContextual();
  await test4_validateNoService();
  await test1_slashCommand();
  await test2_screenshotScenario();
} catch (err) {
  console.error('\nUNEXPECTED ERROR:', err);
  failed++;
} finally {
  await cleanup();
}

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('ALL E2E TESTS PASSED');
}
