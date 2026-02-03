-- Itachi Memory System - Phase 2: Task Orchestration Migration
-- Run this in Supabase SQL Editor AFTER supabase-init.sql

-- ============================================================
-- 1. Tasks table
-- ============================================================
create table if not exists tasks (
    id uuid default gen_random_uuid() primary key,
    description text not null,
    project text not null,
    repo_url text,                          -- git clone URL (null = use local worktree)
    branch text default 'main',             -- base branch
    target_branch text,                     -- feature branch (set by orchestrator)
    status text not null default 'queued'
        check (status in ('queued','claimed','running','completed','failed','cancelled','timeout')),
    priority int default 0,
    model text default 'sonnet',
    max_budget_usd numeric(6,2) default 5.00,
    session_id text,                        -- claude CLI session ID
    result_summary text,
    result_json jsonb,
    error_message text,
    files_changed text[] default '{}',
    pr_url text,
    telegram_chat_id bigint not null,
    telegram_user_id bigint not null,
    orchestrator_id text,                   -- which PC claimed it
    workspace_path text,
    created_at timestamptz default now(),
    started_at timestamptz,
    completed_at timestamptz
);

-- Fast queue polling: find next queued task by priority then age
create index if not exists idx_tasks_queue
    on tasks (status, priority desc, created_at)
    where status = 'queued';

-- User task history
create index if not exists idx_tasks_user
    on tasks (telegram_user_id, created_at desc);

-- ============================================================
-- 2. Add branch + task_id columns to memories
-- ============================================================
alter table memories add column if not exists branch text default 'main';
alter table memories add column if not exists task_id uuid references tasks(id);

-- ============================================================
-- 3. Updated match_memories with optional branch filter
-- ============================================================
create or replace function match_memories(
    query_embedding vector(1536),
    match_project text default null,
    match_category text default null,
    match_branch text default null,
    match_limit int default 5
)
returns table (
    id uuid,
    project text,
    category text,
    content text,
    summary text,
    files text[],
    branch text,
    task_id uuid,
    created_at timestamptz,
    similarity float
)
language plpgsql
as $$
begin
    return query
    select
        m.id,
        m.project,
        m.category,
        m.content,
        m.summary,
        m.files,
        m.branch,
        m.task_id,
        m.created_at,
        1 - (m.embedding <=> query_embedding) as similarity
    from memories m
    where
        (match_project is null or m.project = match_project)
        and (match_category is null or m.category = match_category)
        and (match_branch is null or m.branch = match_branch)
    order by m.embedding <=> query_embedding
    limit match_limit;
end;
$$;

-- ============================================================
-- 4. Atomic task claiming function (prevents race conditions)
-- ============================================================
create or replace function claim_next_task(
    p_orchestrator_id text,
    p_max_budget numeric default null
)
returns setof tasks
language plpgsql
as $$
begin
    return query
    update tasks
    set
        status = 'claimed',
        orchestrator_id = p_orchestrator_id,
        started_at = now()
    where id = (
        select id from tasks
        where status = 'queued'
            and (p_max_budget is null or max_budget_usd <= p_max_budget)
        order by priority desc, created_at asc
        limit 1
        for update skip locked
    )
    returning *;
end;
$$;
