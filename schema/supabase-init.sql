-- Itachi Memory System - Supabase Schema
-- Run this in Supabase SQL Editor to set up the memories table

-- Enable pgvector extension for embeddings
create extension if not exists vector;

-- Create memories table
create table if not exists memories (
    id uuid default gen_random_uuid() primary key,
    project text not null default 'default',
    category text not null default 'code_change',
    content text not null,
    summary text not null,
    files text[] default '{}',
    embedding vector(1536),
    created_at timestamptz default now()
);

-- Index for fast project + date lookups
create index if not exists idx_memories_project_created
    on memories (project, created_at desc);

-- Index for category filtering
create index if not exists idx_memories_category
    on memories (category);

-- Vector similarity search function
create or replace function match_memories(
    query_embedding vector(1536),
    match_project text default null,
    match_category text default null,
    match_limit int default 5
)
returns table (
    id uuid,
    project text,
    category text,
    content text,
    summary text,
    files text[],
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
        m.created_at,
        1 - (m.embedding <=> query_embedding) as similarity
    from memories m
    where
        (match_project is null or m.project = match_project)
        and (match_category is null or m.category = match_category)
    order by m.embedding <=> query_embedding
    limit match_limit;
end;
$$;
