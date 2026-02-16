-- ============================================================
-- Itachi Agent System — Database Schema
-- ============================================================

-- 1. Agent Profiles
CREATE TABLE IF NOT EXISTS itachi_agent_profiles (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  model text NOT NULL DEFAULT 'anthropic/claude-sonnet-4-5',
  system_prompt text NOT NULL DEFAULT '',
  allowed_actions text[] NOT NULL DEFAULT '{}',
  denied_actions text[] NOT NULL DEFAULT '{}',
  memory_namespace text NOT NULL,
  max_concurrent integer NOT NULL DEFAULT 2,
  success_rate float NOT NULL DEFAULT 0.5,
  total_completed integer NOT NULL DEFAULT 0,
  config jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Subagent Runs
CREATE TABLE IF NOT EXISTS itachi_subagent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_run_id uuid REFERENCES itachi_subagent_runs(id) ON DELETE SET NULL,
  agent_profile_id text NOT NULL REFERENCES itachi_agent_profiles(id) ON DELETE CASCADE,
  task text NOT NULL,
  task_id uuid,
  model text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','error','timeout','cancelled')),
  result text,
  error text,
  cleanup_policy text NOT NULL DEFAULT 'keep'
    CHECK (cleanup_policy IN ('delete','keep')),
  timeout_seconds integer NOT NULL DEFAULT 300,
  execution_mode text NOT NULL DEFAULT 'local'
    CHECK (execution_mode IN ('local','ssh')),
  assigned_machine text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_subagent_runs_status ON itachi_subagent_runs(status);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_profile ON itachi_subagent_runs(agent_profile_id);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON itachi_subagent_runs(parent_run_id);

-- 3. Agent Messages
CREATE TABLE IF NOT EXISTS itachi_agent_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_run_id uuid REFERENCES itachi_subagent_runs(id) ON DELETE SET NULL,
  to_run_id uuid REFERENCES itachi_subagent_runs(id) ON DELETE SET NULL,
  from_profile_id text REFERENCES itachi_agent_profiles(id) ON DELETE SET NULL,
  to_profile_id text REFERENCES itachi_agent_profiles(id) ON DELETE SET NULL,
  content text NOT NULL,
  reply_to uuid REFERENCES itachi_agent_messages(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','delivered','read')),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  read_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_to_run ON itachi_agent_messages(to_run_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_messages_to_profile ON itachi_agent_messages(to_profile_id, status);

-- 4. Agent Cron Jobs
CREATE TABLE IF NOT EXISTS itachi_agent_cron (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_profile_id text REFERENCES itachi_agent_profiles(id) ON DELETE SET NULL,
  schedule text NOT NULL,
  task_description text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  max_concurrent_runs integer NOT NULL DEFAULT 1,
  last_run_at timestamptz,
  next_run_at timestamptz,
  run_count integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_cron_next ON itachi_agent_cron(next_run_at) WHERE enabled = true;

-- 5. RPC: Cleanup expired subagents
CREATE OR REPLACE FUNCTION cleanup_expired_subagents()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  affected integer := 0;
  timeout_count integer;
  delete_count integer;
BEGIN
  -- Mark timed-out runs
  UPDATE itachi_subagent_runs
  SET status = 'timeout', ended_at = now()
  WHERE status IN ('pending', 'running')
    AND created_at + (timeout_seconds || ' seconds')::interval < now();
  GET DIAGNOSTICS timeout_count = ROW_COUNT;

  -- Delete old runs with cleanup_policy='delete' (>24h old)
  DELETE FROM itachi_subagent_runs
  WHERE cleanup_policy = 'delete'
    AND status IN ('completed', 'error', 'timeout', 'cancelled')
    AND ended_at < now() - interval '24 hours';
  GET DIAGNOSTICS delete_count = ROW_COUNT;

  affected := timeout_count + delete_count;
  RETURN affected;
END;
$$;

-- 6. Seed Data: Default Profiles
INSERT INTO itachi_agent_profiles (id, display_name, model, system_prompt, allowed_actions, denied_actions, memory_namespace, config)
VALUES
  (
    'code-reviewer',
    'Code Reviewer',
    'anthropic/claude-sonnet-4-5',
    'You are a meticulous code reviewer. Focus on correctness, security vulnerabilities, performance issues, and code style. Provide specific, actionable feedback with line references. Prioritize critical issues over style nits.',
    '{}',
    '{REMOTE_EXEC,COOLIFY_CONTROL}',
    'code-reviewer',
    '{"specialty": "code-review", "tone": "professional"}'
  ),
  (
    'researcher',
    'Researcher',
    'anthropic/claude-opus-4-6',
    'You are a thorough researcher. Analyze topics deeply, cross-reference sources, identify patterns, and produce structured summaries. Always cite your reasoning and flag uncertainty.',
    '{}',
    '{REMOTE_EXEC,COOLIFY_CONTROL,SPAWN_CLAUDE_SESSION}',
    'researcher',
    '{"specialty": "research", "tone": "analytical"}'
  ),
  (
    'devops',
    'DevOps Engineer',
    'anthropic/claude-sonnet-4-5',
    'You are a DevOps engineer. Focus on infrastructure reliability, deployment automation, monitoring, and incident response. Prefer safe, reversible operations. Always verify before making changes.',
    '{}',
    '{}',
    'devops',
    '{"specialty": "infrastructure", "tone": "cautious"}'
  )
ON CONFLICT (id) DO NOTHING;
