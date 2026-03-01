/**
 * Brain Loop Service — state management and helpers for the OODA-cycle brain loop.
 *
 * Plain module (not ElizaOS Service class) following the conversation-flows.ts pattern.
 * Manages config, budget, and proposal CRUD against itachi_brain_proposals table.
 *
 * Supabase table required:
 * CREATE TABLE itachi_brain_proposals (
 *   id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
 *   project TEXT NOT NULL,
 *   title TEXT NOT NULL,
 *   description TEXT NOT NULL,
 *   priority INT NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
 *   status TEXT NOT NULL DEFAULT 'proposed'
 *     CHECK (status IN ('proposed','approved','rejected','expired')),
 *   source TEXT NOT NULL
 *     CHECK (source IN ('github_event','memory_insight','task_failure','health_check','proactive')),
 *   task_id UUID,
 *   telegram_message_id INT,
 *   reasoning TEXT NOT NULL DEFAULT '',
 *   target_machine TEXT,
 *   estimated_complexity TEXT DEFAULT 'medium'
 *     CHECK (estimated_complexity IN ('low','medium','high')),
 *   metadata JSONB DEFAULT '{}',
 *   proposed_at TIMESTAMPTZ DEFAULT now(),
 *   decided_at TIMESTAMPTZ,
 *   expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '24 hours'),
 *   created_at TIMESTAMPTZ DEFAULT now()
 * );
 * CREATE INDEX idx_brain_proposals_status ON itachi_brain_proposals(status);
 * CREATE INDEX idx_brain_proposals_expires ON itachi_brain_proposals(expires_at) WHERE status = 'proposed';
 * CREATE INDEX idx_brain_proposals_project ON itachi_brain_proposals(project, status);
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ── Config ──────────────────────────────────────────────────────────

export interface BrainConfig {
  enabled: boolean;
  intervalMs: number;
  maxProposalsPerCycle: number;
  dailyBudgetLimit: number;
}

const config: BrainConfig = {
  enabled: false, // Disabled by default — user enables with /brain on
  intervalMs: 10 * 60 * 1000, // 10 minutes
  maxProposalsPerCycle: 3,
  dailyBudgetLimit: 20,
};

export function getConfig(): BrainConfig {
  return { ...config };
}

export function updateConfig(updates: Partial<BrainConfig>): void {
  Object.assign(config, updates);
}

// ── Budget Governor ─────────────────────────────────────────────────

let dailyLLMCalls = 0;
let lastBudgetReset = Date.now();

export function resetDailyBudgetIfNeeded(): void {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  if (now - lastBudgetReset >= dayMs) {
    dailyLLMCalls = 0;
    lastBudgetReset = now;
  }
}

export function canAffordLLMCall(): boolean {
  resetDailyBudgetIfNeeded();
  return dailyLLMCalls < config.dailyBudgetLimit;
}

export function recordLLMCall(): void {
  dailyLLMCalls++;
}

export function getBudgetUsage(): { used: number; limit: number } {
  resetDailyBudgetIfNeeded();
  return { used: dailyLLMCalls, limit: config.dailyBudgetLimit };
}

/** Test-only: reset budget counter to zero */
export function resetBudget(): void {
  dailyLLMCalls = 0;
  lastBudgetReset = Date.now();
}

// ── Proposal CRUD ───────────────────────────────────────────────────

export interface BrainProposal {
  id: string;
  project: string;
  title: string;
  description: string;
  priority: number;
  status: string;
  source: string;
  task_id?: string;
  telegram_message_id?: number;
  reasoning: string;
  estimated_complexity: string;
  proposed_at: string;
  decided_at?: string;
  expires_at: string;
}

export async function createProposal(
  supabase: SupabaseClient,
  proposal: {
    project: string;
    title: string;
    description: string;
    priority: number;
    source: string;
    reasoning: string;
    estimated_complexity?: string;
    telegram_message_id?: number;
  },
): Promise<BrainProposal | null> {
  const { data, error } = await supabase
    .from('itachi_brain_proposals')
    .insert({
      project: proposal.project,
      title: proposal.title.substring(0, 200),
      description: proposal.description.substring(0, 2000),
      priority: Math.max(1, Math.min(5, proposal.priority)),
      source: proposal.source,
      reasoning: proposal.reasoning.substring(0, 1000),
      estimated_complexity: proposal.estimated_complexity || 'medium',
      telegram_message_id: proposal.telegram_message_id,
    })
    .select()
    .single();

  if (error) return null;
  return data as BrainProposal;
}

export async function approveProposal(
  supabase: SupabaseClient,
  proposalId: string,
  taskId: string,
): Promise<void> {
  await supabase
    .from('itachi_brain_proposals')
    .update({
      status: 'approved',
      task_id: taskId,
      decided_at: new Date().toISOString(),
    })
    .eq('id', proposalId);
}

export async function rejectProposal(
  supabase: SupabaseClient,
  proposalId: string,
): Promise<void> {
  await supabase
    .from('itachi_brain_proposals')
    .update({
      status: 'rejected',
      decided_at: new Date().toISOString(),
    })
    .eq('id', proposalId);
}

export async function expireOldProposals(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase
    .from('itachi_brain_proposals')
    .update({ status: 'expired', decided_at: new Date().toISOString() })
    .eq('status', 'proposed')
    .lt('expires_at', new Date().toISOString())
    .select('id');

  if (error) return 0;
  return data?.length || 0;
}

export async function getPendingProposals(supabase: SupabaseClient): Promise<BrainProposal[]> {
  const { data } = await supabase
    .from('itachi_brain_proposals')
    .select('*')
    .eq('status', 'proposed')
    .order('priority', { ascending: false })
    .limit(20);

  return (data || []) as BrainProposal[];
}

export async function getDailyStats(supabase: SupabaseClient): Promise<{
  proposed: number;
  approved: number;
  rejected: number;
  expired: number;
}> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data } = await supabase
    .from('itachi_brain_proposals')
    .select('status')
    .gte('created_at', todayStart.toISOString());

  const stats = { proposed: 0, approved: 0, rejected: 0, expired: 0 };
  for (const row of data || []) {
    const s = row.status as keyof typeof stats;
    if (s in stats) stats[s]++;
  }
  return stats;
}

// ── Dedup Check ─────────────────────────────────────────────────────

export async function isDuplicate(
  supabase: SupabaseClient,
  title: string,
  project: string,
): Promise<boolean> {
  const titleLower = title.toLowerCase();

  // Check pending proposals
  const { data: proposals } = await supabase
    .from('itachi_brain_proposals')
    .select('title')
    .eq('status', 'proposed')
    .eq('project', project)
    .limit(20);

  if (proposals?.some(p => p.title.toLowerCase() === titleLower)) return true;

  // Check active tasks
  const { data: tasks } = await supabase
    .from('itachi_tasks')
    .select('description')
    .in('status', ['queued', 'claimed', 'running'])
    .eq('project', project)
    .limit(20);

  if (tasks?.some(t => t.description?.toLowerCase().includes(titleLower))) return true;

  return false;
}
