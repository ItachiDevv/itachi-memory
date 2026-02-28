import { type TaskWorker, type IAgentRuntime, ModelType } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { MachineRegistryService } from '../services/machine-registry.js';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';
import {
  getConfig,
  canAffordLLMCall,
  recordLLMCall,
  expireOldProposals,
  createProposal,
  isDuplicate,
  resetDailyBudgetIfNeeded,
} from '../services/brain-loop-service.js';

let lastBrainLoopRun = 0;
// Startup delay: wait 2 minutes after boot before first run
const STARTUP_DELAY_MS = 2 * 60 * 1000;
const startupTime = Date.now();

interface Observation {
  type: string;
  title: string;
  detail: string;
  project?: string;
}

export const brainLoopWorker: TaskWorker = {
  name: 'ITACHI_BRAIN_LOOP',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => {
    const config = getConfig();
    if (!config.enabled) return false;
    if (Date.now() - startupTime < STARTUP_DELAY_MS) return false;
    return Date.now() - lastBrainLoopRun >= config.intervalMs;
  },

  execute: async (runtime: IAgentRuntime): Promise<void> => {
    const config = getConfig();
    if (!config.enabled) return;

    const taskService = runtime.getService<TaskService>('itachi-tasks');
    if (!taskService) return;

    const supabase = taskService.getSupabase();

    try {
      // 1. Expire old proposals (housekeeping, no LLM)
      const expired = await expireOldProposals(supabase);
      if (expired > 0) {
        runtime.logger.info(`[brain-loop] Expired ${expired} old proposals`);
      }

      // 2. Observe (data gathering, no LLM)
      const observations = await gatherObservations(runtime);

      // 3. Early exit if nothing to observe
      if (observations.length === 0) {
        lastBrainLoopRun = Date.now();
        return;
      }

      // 4. Budget check
      resetDailyBudgetIfNeeded();
      if (!canAffordLLMCall()) {
        runtime.logger.info('[brain-loop] Daily budget exhausted, skipping Orient phase');
        lastBrainLoopRun = Date.now();
        return;
      }

      // 5. Orient (single LLM call)
      const observationText = observations
        .map(o => `[${o.type}] ${o.title}: ${o.detail}${o.project ? ` (project: ${o.project})` : ''}`)
        .join('\n');

      const prompt = `You are a proactive engineering assistant analyzing system observations.

Given these observations about the project ecosystem:

${observationText}

Identify the top ${config.maxProposalsPerCycle} actionable items ranked by urgency and impact.
For each, provide:
- title: short title (under 50 chars)
- description: specific, actionable description of what to do (under 200 chars)
- priority: 1-5 (5 = critical)
- reasoning: why this matters (under 100 chars)
- target_project: which project this applies to
- estimated_complexity: low, medium, or high
- source: one of: github_event, memory_insight, task_failure, health_check, proactive

Respond as a JSON array. No markdown code blocks.
Return [] if no observations warrant action.`;

      const result = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.3,
      });
      recordLLMCall();

      const responseText = typeof result === 'string' ? result : String(result);
      if (!responseText || responseText.length < 10) {
        lastBrainLoopRun = Date.now();
        return;
      }

      let items: Array<{
        title: string;
        description: string;
        priority: number;
        reasoning: string;
        target_project: string;
        estimated_complexity: string;
        source: string;
      }>;

      try {
        const cleaned = responseText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
        items = JSON.parse(arrayMatch ? arrayMatch[0] : cleaned);
      } catch {
        runtime.logger.warn('[brain-loop] Failed to parse LLM response');
        lastBrainLoopRun = Date.now();
        return;
      }

      if (!Array.isArray(items) || items.length === 0) {
        lastBrainLoopRun = Date.now();
        return;
      }

      // 6. Decide (filter + deduplicate)
      const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
      let proposalCount = 0;

      for (const item of items.slice(0, config.maxProposalsPerCycle)) {
        if (!item.title || !item.description || !item.target_project) continue;

        // Dedup check
        if (await isDuplicate(supabase, item.title, item.target_project)) {
          runtime.logger.info(`[brain-loop] Skipping duplicate: "${item.title}"`);
          continue;
        }

        // 7. Act — create proposal and send to Telegram
        const proposal = await createProposal(supabase, {
          project: item.target_project,
          title: item.title,
          description: item.description,
          priority: item.priority || 3,
          source: item.source || 'proactive',
          reasoning: item.reasoning || '',
          estimated_complexity: item.estimated_complexity || 'medium',
        });

        if (!proposal) continue;

        // Send to Telegram with approve/reject buttons
        if (topicsService) {
          try {
            const shortId = proposal.id.substring(0, 8);
            const priorityStars = '★'.repeat(Math.min(5, item.priority || 3));
            const message = `[Brain Loop] Proposed Task\n\nTitle: ${item.title}\nProject: ${item.target_project}\nPriority: ${priorityStars} (${item.priority}/5)\nComplexity: ${item.estimated_complexity || 'medium'}\n\nReasoning: ${item.reasoning}\n\nDescription: ${item.description}`;

            const keyboard = [
              [
                { text: 'Approve', callback_data: `bp:a:${shortId}` },
                { text: 'Reject', callback_data: `bp:r:${shortId}` },
              ],
            ];

            const sent = await topicsService.sendMessageWithKeyboard(message, keyboard);

            // Update proposal with telegram message ID
            if (sent) {
              await supabase
                .from('itachi_brain_proposals')
                .update({ telegram_message_id: sent })
                .eq('id', proposal.id);
            }

            proposalCount++;
          } catch (err) {
            runtime.logger.warn(`[brain-loop] Failed to send proposal to Telegram: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      if (proposalCount > 0) {
        runtime.logger.info(`[brain-loop] Sent ${proposalCount} proposal(s) to Telegram`);
      }

      lastBrainLoopRun = Date.now();
    } catch (error) {
      runtime.logger.error('[brain-loop] Error:', error instanceof Error ? error.message : String(error));
      lastBrainLoopRun = Date.now();
    }
  },
};

// ── Observation Gathering ───────────────────────────────────────────

async function gatherObservations(runtime: IAgentRuntime): Promise<Observation[]> {
  const observations: Observation[] = [];
  const taskService = runtime.getService<TaskService>('itachi-tasks');
  const registry = runtime.getService<MachineRegistryService>('machine-registry');
  const memoryService = runtime.getService<MemoryService>('itachi-memory');

  // Failed tasks in last hour
  if (taskService) {
    try {
      const supabase = taskService.getSupabase();
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      const { data: failedTasks } = await supabase
        .from('itachi_tasks')
        .select('id, project, description, error_message')
        .eq('status', 'failed')
        .gte('completed_at', hourAgo)
        .limit(5);

      for (const t of failedTasks || []) {
        observations.push({
          type: 'task_failure',
          title: `Task ${t.id.substring(0, 8)} failed`,
          detail: t.error_message?.substring(0, 150) || 'Unknown error',
          project: t.project,
        });
      }

      // Stale running tasks (>1h)
      const { data: staleTasks } = await supabase
        .from('itachi_tasks')
        .select('id, project, description')
        .eq('status', 'running')
        .lt('started_at', hourAgo)
        .limit(5);

      for (const t of staleTasks || []) {
        observations.push({
          type: 'health_check',
          title: `Task ${t.id.substring(0, 8)} running >1h`,
          detail: (t.description || '').substring(0, 100),
          project: t.project,
        });
      }
    } catch { /* non-critical */ }
  }

  // Machine health
  if (registry) {
    try {
      const machines = await registry.getAllMachines();
      const offline = machines.filter(m => m.status === 'offline');
      if (offline.length > 0 && machines.length > 0) {
        observations.push({
          type: 'health_check',
          title: `${offline.length}/${machines.length} machines offline`,
          detail: offline.map(m => m.display_name || m.machine_id).join(', '),
        });
      }
    } catch { /* non-critical */ }
  }

  // Recent error_recovery memories
  if (memoryService) {
    try {
      const supabase = memoryService.getSupabase();
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      const { data: errors } = await supabase
        .from('itachi_memories')
        .select('project, summary')
        .eq('category', 'error_recovery')
        .gte('created_at', hourAgo)
        .limit(3);

      for (const e of errors || []) {
        observations.push({
          type: 'memory_insight',
          title: 'Recent error pattern',
          detail: (e.summary || '').substring(0, 150),
          project: e.project,
        });
      }
    } catch { /* non-critical */ }
  }

  return observations;
}

export async function registerBrainLoopTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_BRAIN_LOOP');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_BRAIN_LOOP task already exists, skipping');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_BRAIN_LOOP',
      description: 'Proactive OODA-cycle brain loop (10min interval)',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 10 * 60 * 1000,
      },
      tags: ['repeat'],
    } as any);
    runtime.logger.info('Registered ITACHI_BRAIN_LOOP repeating task (10min)');
  } catch (error: unknown) {
    runtime.logger.error('Failed to register brain loop task:', error instanceof Error ? error.message : String(error));
  }
}
