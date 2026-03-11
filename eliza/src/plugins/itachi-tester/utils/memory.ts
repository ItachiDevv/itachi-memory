import type { SupabaseClient } from '@supabase/supabase-js';
import type { TestRun, HistoricalResult, TestStatus } from '../types.js';

const PROJECT = 'itachi-tester';

export async function saveTestRunMemory(
  supabase: SupabaseClient,
  run: TestRun,
  markdownReport: string
): Promise<void> {
  const meta: Record<string, unknown> = {
    run_id: run.id,
    started_at: run.startedAt,
    completed_at: run.completedAt,
    duration_ms: run.durationMs,
    total_pass: run.totalPass,
    total_fail: run.totalFail,
    total_skip: run.totalSkip,
    total_error: run.totalError,
    suites: run.suites.map(s => ({
      name: s.name,
      pass: s.passCount,
      fail: s.failCount,
      skip: s.skipCount,
      error: s.errorCount,
    })),
  };

  await supabase.from('itachi_memories').insert({
    project: PROJECT,
    category: 'test_result',
    content: markdownReport,
    summary: `Test run ${run.id.substring(0, 8)}: ${run.totalPass}✅ ${run.totalFail}❌ ${run.totalSkip}⏭ in ${Math.round(run.durationMs / 1000)}s`,
    files: [],
    metadata: meta,
  });
}

export async function loadRecentTestResults(
  supabase: SupabaseClient,
  limit = 10
): Promise<Array<{ run_id: string; metadata: Record<string, unknown>; created_at: string }>> {
  const { data, error } = await supabase
    .from('itachi_memories')
    .select('id, summary, metadata, created_at')
    .eq('project', PROJECT)
    .eq('category', 'test_result')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data.map(d => ({
    run_id: (d.metadata as Record<string, unknown>)?.run_id as string || d.id,
    metadata: (d.metadata || {}) as Record<string, unknown>,
    created_at: d.created_at,
  }));
}

export interface TestPassHistory {
  /** map from "suiteName::testName" -> array of statuses (most recent last) */
  [key: string]: TestStatus[];
}

export async function buildPassHistory(
  supabase: SupabaseClient,
  runs = 5
): Promise<TestPassHistory> {
  const recent = await loadRecentTestResults(supabase, runs);
  const history: TestPassHistory = {};

  for (const entry of recent) {
    const suites = entry.metadata.suites as Array<{ name: string; pass: number; fail: number; skip: number; error: number }> | undefined;
    if (!suites) continue;
    for (const s of suites) {
      const key = s.name;
      if (!history[key]) history[key] = [];
      // Derive suite-level status from counts
      const status: TestStatus = s.fail > 0 || s.error > 0 ? 'fail' : s.skip > 0 && s.pass === 0 ? 'skip' : 'pass';
      history[key].unshift(status); // prepend oldest first
    }
  }
  return history;
}

export async function saveLessonMemory(
  supabase: SupabaseClient,
  suiteName: string,
  lesson: string,
  category: 'test_lesson' | 'test_alert'
): Promise<void> {
  await supabase.from('itachi_memories').insert({
    project: PROJECT,
    category,
    content: lesson,
    summary: `[${suiteName}] ${lesson.substring(0, 120)}`,
    files: [],
    metadata: { suite: suiteName, recorded_at: new Date().toISOString() },
  });
}

export async function applyRLMLearning(
  supabase: SupabaseClient,
  run: TestRun,
  logger: { info: (msg: string) => void; warn: (msg: string) => void }
): Promise<void> {
  const history = await buildPassHistory(supabase, 5);

  for (const suite of run.suites) {
    const currentStatus: TestStatus = suite.failCount > 0 || suite.errorCount > 0 ? 'fail' : suite.skipCount === suite.results.length ? 'skip' : 'pass';
    const prev = history[suite.name] || [];

    // Test was failing before but passes now
    if (currentStatus === 'pass' && prev.length > 0 && prev[prev.length - 1] === 'fail') {
      const lesson = `Suite "${suite.name}" recovered from failure — previously failing, now passing.`;
      logger.info(`[itachi-tester] RLM lesson: ${lesson}`);
      await saveLessonMemory(supabase, suite.name, lesson, 'test_lesson').catch(() => {});
    }

    // Test keeps failing 3+ runs in a row
    if (prev.length >= 2 && currentStatus === 'fail' &&
      prev.slice(-2).every(s => s === 'fail')) {
      const alert = `Suite "${suite.name}" has been failing for 3+ consecutive runs. Attention required.`;
      logger.warn(`[itachi-tester] RLM alert: ${alert}`);
      await saveLessonMemory(supabase, suite.name, alert, 'test_alert').catch(() => {});
    }
  }
}
