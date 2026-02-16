// ============================================================
// Itachi Agent System — Type Definitions
// ============================================================

/** Persistent agent profile stored in Supabase */
export interface AgentProfile {
  id: string;
  display_name: string;
  model: string;
  system_prompt: string;
  allowed_actions: string[];
  denied_actions: string[];
  memory_namespace: string;
  max_concurrent: number;
  success_rate: number;
  total_completed: number;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Subagent run lifecycle entry */
export interface SubagentRun {
  id: string;
  parent_run_id: string | null;
  agent_profile_id: string;
  task: string;
  task_id: string | null;
  model: string | null;
  status: SubagentStatus;
  result: string | null;
  error: string | null;
  cleanup_policy: 'delete' | 'keep';
  timeout_seconds: number;
  execution_mode: 'local' | 'ssh';
  assigned_machine: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export type SubagentStatus = 'pending' | 'running' | 'completed' | 'error' | 'timeout' | 'cancelled';

/** Inter-agent message */
export interface AgentMessage {
  id: string;
  from_run_id: string | null;
  to_run_id: string | null;
  from_profile_id: string | null;
  to_profile_id: string | null;
  content: string;
  reply_to: string | null;
  status: 'pending' | 'delivered' | 'read';
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
}

/** Agent cron job definition */
export interface AgentCronJob {
  id: string;
  agent_profile_id: string | null;
  schedule: string;
  task_description: string;
  enabled: boolean;
  max_concurrent_runs: number;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Options for spawning a subagent */
export interface SpawnOptions {
  profileId: string;
  task: string;
  parentRunId?: string;
  model?: string;
  executionMode?: 'local' | 'ssh';
  timeoutSeconds?: number;
  cleanupPolicy?: 'delete' | 'keep';
  metadata?: Record<string, unknown>;
}

/** Result from a local subagent execution */
export interface LocalExecutionResult {
  success: boolean;
  result?: string;
  error?: string;
}

/** Parsed cron schedule fields */
export interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}
