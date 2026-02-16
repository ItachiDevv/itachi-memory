import { Service, type IAgentRuntime } from '@elizaos/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AgentCronJob, CronFields } from '../types.js';

export class AgentCronService extends Service {
  static serviceType = 'itachi-agent-cron';
  capabilityDescription = 'Agent-self-scheduled cron jobs';

  private supabase: SupabaseClient;
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
    const url = runtime.getSetting('SUPABASE_URL');
    const key = runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY') || runtime.getSetting('SUPABASE_KEY');
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for AgentCronService');
    this.supabase = createClient(url, key);
  }

  static async start(runtime: IAgentRuntime): Promise<AgentCronService> {
    const service = new AgentCronService(runtime);
    runtime.logger.info('[agent-cron] Service started');
    return service;
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('[agent-cron] Service stopped');
  }

  /** Create a new cron job */
  async createJob(opts: {
    profileId?: string;
    schedule: string;
    taskDescription: string;
    maxConcurrentRuns?: number;
    metadata?: Record<string, unknown>;
  }): Promise<AgentCronJob | null> {
    // Validate cron expression
    const parsed = parseCron(opts.schedule);
    if (!parsed) {
      this.runtime.logger.error('[agent-cron] Invalid cron expression:', opts.schedule);
      return null;
    }

    const nextRun = getNextRun(parsed, new Date());

    const { data, error } = await this.supabase
      .from('itachi_agent_cron')
      .insert({
        agent_profile_id: opts.profileId || null,
        schedule: opts.schedule,
        task_description: opts.taskDescription,
        max_concurrent_runs: opts.maxConcurrentRuns ?? 1,
        next_run_at: nextRun.toISOString(),
        metadata: opts.metadata || {},
      })
      .select()
      .single();

    if (error) {
      this.runtime.logger.error('[agent-cron] createJob error:', error.message);
      return null;
    }
    return data as AgentCronJob;
  }

  /** List all cron jobs */
  async listJobs(enabledOnly = true): Promise<AgentCronJob[]> {
    let query = this.supabase.from('itachi_agent_cron').select('*').order('created_at');
    if (enabledOnly) query = query.eq('enabled', true);

    const { data, error } = await query;
    if (error) {
      this.runtime.logger.error('[agent-cron] listJobs error:', error.message);
      return [];
    }
    return (data || []) as AgentCronJob[];
  }

  /** Get jobs that are due to run */
  async getDueJobs(): Promise<AgentCronJob[]> {
    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('itachi_agent_cron')
      .select('*')
      .eq('enabled', true)
      .lte('next_run_at', now);

    if (error) {
      this.runtime.logger.error('[agent-cron] getDueJobs error:', error.message);
      return [];
    }
    return (data || []) as AgentCronJob[];
  }

  /** Mark a job as having just run; compute next_run_at */
  async markRun(jobId: string, schedule: string): Promise<void> {
    const parsed = parseCron(schedule);
    if (!parsed) return;

    const nextRun = getNextRun(parsed, new Date());
    const { error } = await this.supabase
      .from('itachi_agent_cron')
      .update({
        last_run_at: new Date().toISOString(),
        next_run_at: nextRun.toISOString(),
        run_count: this.supabase.rpc ? undefined : undefined, // increment below
      })
      .eq('id', jobId);

    if (error) this.runtime.logger.error('[agent-cron] markRun error:', error.message);

    // Increment run_count separately (Supabase doesn't easily do col + 1 in update)
    await this.supabase.rpc('increment_cron_run_count', { job_id: jobId }).catch(() => {
      // Fallback: manual increment if RPC doesn't exist yet
      this.supabase
        .from('itachi_agent_cron')
        .select('run_count')
        .eq('id', jobId)
        .single()
        .then(({ data }) => {
          if (data) {
            this.supabase
              .from('itachi_agent_cron')
              .update({ run_count: (data.run_count || 0) + 1 })
              .eq('id', jobId)
              .then(() => {});
          }
        });
    });
  }

  /** Cancel (disable) a cron job */
  async cancelJob(jobId: string): Promise<boolean> {
    const { error } = await this.supabase
      .from('itachi_agent_cron')
      .update({ enabled: false })
      .eq('id', jobId);
    return !error;
  }

  /** Delete a cron job */
  async deleteJob(jobId: string): Promise<boolean> {
    const { error } = await this.supabase
      .from('itachi_agent_cron')
      .delete()
      .eq('id', jobId);
    return !error;
  }
}

// ============================================================
// Minimal Cron Parser
// ============================================================

/** Parse a 5-field cron expression. Supports *, specific values, ranges (1-5), steps (*​/N) */
export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  try {
    return {
      minute: parseField(parts[0], 0, 59),
      hour: parseField(parts[1], 0, 23),
      dayOfMonth: parseField(parts[2], 1, 31),
      month: parseField(parts[3], 1, 12),
      dayOfWeek: parseField(parts[4], 0, 6),
    };
  } catch {
    return null;
  }
}

function parseField(field: string, min: number, max: number): number[] {
  const values: number[] = [];
  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.push(i);
    } else if (part.includes('/')) {
      const [base, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step < 1) throw new Error('Invalid step');
      const start = base === '*' ? min : parseInt(base, 10);
      for (let i = start; i <= max; i += step) values.push(i);
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      for (let i = lo; i <= hi; i++) values.push(i);
    } else {
      const val = parseInt(part, 10);
      if (isNaN(val) || val < min || val > max) throw new Error('Out of range');
      values.push(val);
    }
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Get the next run time after `after` for the given cron fields */
export function getNextRun(fields: CronFields, after: Date): Date {
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // At least 1 minute in the future

  // Brute-force search up to 366 days
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (
      fields.month.includes(d.getMonth() + 1) &&
      fields.dayOfMonth.includes(d.getDate()) &&
      fields.dayOfWeek.includes(d.getDay()) &&
      fields.hour.includes(d.getHours()) &&
      fields.minute.includes(d.getMinutes())
    ) {
      return d;
    }
    d.setMinutes(d.getMinutes() + 1);
  }

  // Fallback: 1 hour from now
  return new Date(after.getTime() + 3_600_000);
}
