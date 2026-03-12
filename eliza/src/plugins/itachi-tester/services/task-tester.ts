import type { SupabaseClient } from '@supabase/supabase-js';
import type { TestResult } from '../types.js';

const HOSTS = ['mac', 'surface', 'hoodie', 'coolify', 'hetzner-vps'];
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 120_000;

async function insertTask(
  supabase: SupabaseClient,
  opts: {
    description: string;
    assigned_machine?: string;
    project?: string;
  }
): Promise<{ id: string; queued_at: string } | null> {
  const { data, error } = await supabase
    .from('itachi_tasks')
    .insert({
      description: opts.description,
      status: 'queued',
      assigned_machine: opts.assigned_machine ?? null,
      project: opts.project ?? 'itachi-tester',
      title: `[tester] ${opts.description.substring(0, 60)}`,
      created_at: new Date().toISOString(),
    })
    .select('id, created_at')
    .single();

  if (error || !data) return null;
  return { id: data.id, queued_at: data.created_at };
}

async function pollTaskCompletion(
  supabase: SupabaseClient,
  taskId: string
): Promise<{ status: string; result?: string; completedAt?: string } | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { data, error } = await supabase
      .from('itachi_tasks')
      .select('status, result, completed_at, error_message')
      .eq('id', taskId)
      .single();

    if (!error && data) {
      if (data.status === 'completed' || data.status === 'failed') {
        return {
          status: data.status,
          result: data.result || data.error_message || undefined,
          completedAt: data.completed_at || undefined,
        };
      }
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null; // timed out
}

async function cleanupTask(supabase: SupabaseClient, taskId: string): Promise<void> {
  await supabase.from('itachi_tasks').delete().eq('id', taskId).eq('project', 'itachi-tester');
}

export async function runTaskTests(supabase: SupabaseClient): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Per-host tests
  for (const host of HOSTS) {
    const start = Date.now();
    let taskId: string | null = null;
    try {
      const inserted = await insertTask(supabase, {
        description: `echo hello-from-${host} && echo test-complete`,
        assigned_machine: host,
      });

      if (!inserted) {
        results.push({
          name: `host-${host}`,
          status: 'fail',
          durationMs: Date.now() - start,
          message: 'Failed to insert task',
        });
        continue;
      }
      taskId = inserted.id;

      const completion = await pollTaskCompletion(supabase, taskId);
      const durationMs = Date.now() - start;

      if (!completion) {
        results.push({
          name: `host-${host}`,
          status: 'fail',
          durationMs,
          message: `Timed out after ${POLL_TIMEOUT_MS / 1000}s`,
          metadata: { task_id: taskId, queued_at: inserted.queued_at },
        });
      } else {
        const latencyMs = completion.completedAt
          ? new Date(completion.completedAt).getTime() - new Date(inserted.queued_at).getTime()
          : durationMs;
        results.push({
          name: `host-${host}`,
          status: completion.status === 'completed' ? 'pass' : 'fail',
          durationMs,
          message: `Task ${completion.status} in ${Math.round(latencyMs / 1000)}s`,
          detail: completion.result?.substring(0, 200),
          metadata: {
            task_id: taskId,
            queued_at: inserted.queued_at,
            completed_at: completion.completedAt,
            latency_ms: latencyMs,
          },
        });
      }
    } catch (err) {
      results.push({
        name: `host-${host}`,
        status: 'error',
        durationMs: Date.now() - start,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (taskId) await cleanupTask(supabase, taskId).catch(() => {});
    }
  }

  // Edge case: no assigned machine
  {
    const start = Date.now();
    let taskId: string | null = null;
    try {
      const inserted = await insertTask(supabase, {
        description: 'echo unassigned-task-test',
      });
      if (inserted) {
        taskId = inserted.id;
        const completion = await pollTaskCompletion(supabase, taskId);
        results.push({
          name: 'edge-unassigned-machine',
          status: completion ? (completion.status === 'completed' ? 'pass' : 'fail') : 'fail',
          durationMs: Date.now() - start,
          message: completion ? `Task ${completion.status}` : 'Timed out — no worker claimed unassigned task',
        });
      } else {
        results.push({ name: 'edge-unassigned-machine', status: 'fail', durationMs: Date.now() - start, message: 'Insert failed' });
      }
    } catch (err) {
      results.push({ name: 'edge-unassigned-machine', status: 'error', durationMs: Date.now() - start, message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (taskId) await cleanupTask(supabase, taskId).catch(() => {});
    }
  }

  // Edge case: invalid machine name — should stay queued or error gracefully
  {
    const start = Date.now();
    let taskId: string | null = null;
    try {
      const inserted = await insertTask(supabase, {
        description: 'echo invalid-machine-test',
        assigned_machine: 'nonexistent-machine-xyz',
      });
      if (inserted) {
        taskId = inserted.id;
        // Wait 15s — task should NOT complete (no worker for that machine)
        await new Promise(resolve => setTimeout(resolve, 15_000));
        const { data } = await supabase.from('itachi_tasks').select('status').eq('id', taskId).single();
        const stillQueued = data?.status === 'queued' || data?.status === 'failed';
        results.push({
          name: 'edge-invalid-machine',
          status: stillQueued ? 'pass' : 'fail',
          durationMs: Date.now() - start,
          message: stillQueued ? `Task gracefully stayed in status: ${data?.status}` : `Unexpected status: ${data?.status}`,
        });
      } else {
        results.push({ name: 'edge-invalid-machine', status: 'fail', durationMs: Date.now() - start, message: 'Insert failed' });
      }
    } catch (err) {
      results.push({ name: 'edge-invalid-machine', status: 'error', durationMs: Date.now() - start, message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (taskId) await cleanupTask(supabase, taskId).catch(() => {});
    }
  }

  // Edge case: concurrency — 3 tasks to same host simultaneously
  {
    const start = Date.now();
    const taskIds: string[] = [];
    try {
      const host = 'mac';
      const insertPromises = [1, 2, 3].map(i =>
        insertTask(supabase, { description: `echo concurrency-test-${i}`, assigned_machine: host })
      );
      const inserted = await Promise.all(insertPromises);
      for (const t of inserted) {
        if (t) taskIds.push(t.id);
      }
      if (taskIds.length < 3) {
        results.push({ name: 'edge-concurrency', status: 'fail', durationMs: Date.now() - start, message: `Only ${taskIds.length}/3 tasks inserted` });
      } else {
        // Wait for all to complete (120s)
        const completions = await Promise.all(taskIds.map(id => pollTaskCompletion(supabase, id)));
        const allDone = completions.filter(Boolean).length;
        const allSuccess = completions.filter(c => c?.status === 'completed').length;
        results.push({
          name: 'edge-concurrency',
          status: allDone === 3 ? 'pass' : 'fail',
          durationMs: Date.now() - start,
          message: `${allDone}/3 completed, ${allSuccess}/3 succeeded`,
        });
      }
    } catch (err) {
      results.push({ name: 'edge-concurrency', status: 'error', durationMs: Date.now() - start, message: err instanceof Error ? err.message : String(err) });
    } finally {
      for (const id of taskIds) await cleanupTask(supabase, id).catch(() => {});
    }
  }

  // Edge case: very long description
  {
    const start = Date.now();
    let taskId: string | null = null;
    try {
      const longDesc = 'echo long-desc-test ' + 'a'.repeat(1980);
      const inserted = await insertTask(supabase, { description: longDesc });
      if (inserted) {
        taskId = inserted.id;
        const completion = await pollTaskCompletion(supabase, taskId);
        results.push({
          name: 'edge-long-description',
          status: completion ? 'pass' : 'fail',
          durationMs: Date.now() - start,
          message: completion ? `Completed with status: ${completion.status}` : 'Timed out',
        });
      } else {
        results.push({ name: 'edge-long-description', status: 'fail', durationMs: Date.now() - start, message: 'Insert failed (may be DB constraint)' });
      }
    } catch (err) {
      results.push({ name: 'edge-long-description', status: 'error', durationMs: Date.now() - start, message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (taskId) await cleanupTask(supabase, taskId).catch(() => {});
    }
  }

  // Edge case: special chars in description
  {
    const start = Date.now();
    let taskId: string | null = null;
    try {
      const inserted = await insertTask(supabase, { description: "echo 'special chars: !@#$%^&*()[]{}|;<>?,./'" });
      if (inserted) {
        taskId = inserted.id;
        const completion = await pollTaskCompletion(supabase, taskId);
        results.push({
          name: 'edge-special-chars',
          status: completion ? 'pass' : 'fail',
          durationMs: Date.now() - start,
          message: completion ? `Completed with status: ${completion.status}` : 'Timed out',
        });
      } else {
        results.push({ name: 'edge-special-chars', status: 'fail', durationMs: Date.now() - start, message: 'Insert failed' });
      }
    } catch (err) {
      results.push({ name: 'edge-special-chars', status: 'error', durationMs: Date.now() - start, message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (taskId) await cleanupTask(supabase, taskId).catch(() => {});
    }
  }

  return results;
}
