-- Itachi Secrets Sync - Encrypted cross-device secret sharing
-- Run this in Supabase SQL Editor

create table if not exists secrets (
    id uuid default gen_random_uuid() primary key,
    name text not null unique,
    encrypted_data text not null,
    salt text not null,
    description text,
    updated_by text,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create index if not exists idx_secrets_name on secrets (name);
