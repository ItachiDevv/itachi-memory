import { type TaskWorker, type IAgentRuntime } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';
import { MachineRegistryService } from '../services/machine-registry.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { SSHService } from '../services/ssh-service.js';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';

let lastHealthMonitorRun = 0;
const HEALTH_MONITOR_INTERVAL_MS = 60_000; // 60 seconds

// Track last alert times to prevent spam (key: alert type, value: timestamp)
const lastAlerts = new Map<string, number>();
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min between same alert type

// Track consecutive critical failures for auto-restart (Phase 3B)
let consecutiveCriticalFailures = 0;
const AUTO_RESTART_THRESHOLD = 3;
let lastAutoRestart = 0;
const AUTO_RESTART_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between auto-restarts

function shouldAlert(alertKey: string): boolean {
  const last = lastAlerts.get(alertKey) || 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return false;
  lastAlerts.set(alertKey, Date.now());
  return true;
}

export interface HealthStatus {
  supabase: 'ok' | 'error';
  machines: { total: number; online: number };
  staleTasks: number;
  memoryCount: number;
  timestamp: string;
}

// Expose last health status for /health command
export let lastHealthStatus: HealthStatus | null = null;

export const healthMonitorWorker: TaskWorker = {
  name: 'ITACHI_HEALTH_MONITOR',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => {
    return Date.now() - lastHealthMonitorRun >= HEALTH_MONITOR_INTERVAL_MS;
  },

  execute: async (runtime: IAgentRuntime): Promise<void> => {
    try {
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      const registry = runtime.getService<MachineRegistryService>('machine-registry');
      const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');

      const status: HealthStatus = {
        supabase: 'ok',
        machines: { total: 0, online: 0 },
        staleTasks: 0,
        memoryCount: 0,
        timestamp: new Date().toISOString(),
      };

      // 1. Check Supabase connectivity
      if (taskService) {
        try {
          const supabase = taskService.getSupabase();
          const { error } = await supabase.from('itachi_tasks').select('id').limit(1);
          if (error) {
            status.supabase = 'error';
            runtime.logger.error(`[health] Supabase connectivity error: ${error.message}`);
            if (shouldAlert('supabase') && topicsService) {
              await topicsService.sendMessageWithKeyboard(
                `[Health Alert] Supabase connectivity issue: ${error.message}`,
                [],
              ).catch((err: unknown) => { runtime.logger.debug(`[health] alert send failed: ${err instanceof Error ? err.message : String(err)}`); });
            }
          }
        } catch (err) {
          status.supabase = 'error';
          runtime.logger.error(`[health] Supabase check failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 2. Check machine registry
      if (registry) {
        try {
          const allMachines = await registry.getAllMachines();
          status.machines.total = allMachines.length;
          status.machines.online = allMachines.filter(m => m.status === 'online').length;

          if (status.machines.total > 0 && status.machines.online === 0) {
            runtime.logger.warn('[health] No machines online');
            if (shouldAlert('no-machines') && topicsService) {
              await topicsService.sendMessageWithKeyboard(
                `[Health Alert] No machines are currently online (${status.machines.total} registered, 0 online).`,
                [],
              ).catch((err: unknown) => { runtime.logger.debug(`[health] alert send failed: ${err instanceof Error ? err.message : String(err)}`); });
            }
          }
        } catch (err) {
          runtime.logger.warn(`[health] Machine registry check failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 3. Check for stale tasks (running >10min without heartbeat)
      if (taskService) {
        try {
          const supabase = taskService.getSupabase();
          const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
          const { data: staleTasks } = await supabase
            .from('itachi_tasks')
            .select('id, project, status, started_at')
            .in('status', ['running', 'claimed'])
            .lt('started_at', staleThreshold)
            .limit(10);

          status.staleTasks = staleTasks?.length || 0;
          if (status.staleTasks > 0) {
            runtime.logger.warn(`[health] ${status.staleTasks} stale task(s) detected`);
            if (shouldAlert('stale-tasks') && topicsService) {
              const taskList = (staleTasks || [])
                .map(t => `  - ${t.id.substring(0, 8)} (${t.project}, ${t.status})`)
                .join('\n');
              await topicsService.sendMessageWithKeyboard(
                `[Health Alert] ${status.staleTasks} task(s) appear stuck (running >10min):\n${taskList}`,
                [],
              ).catch((err: unknown) => { runtime.logger.debug(`[health] alert send failed: ${err instanceof Error ? err.message : String(err)}`); });
            }
          }
        } catch (err) {
          runtime.logger.warn(`[health] Stale task check failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 4. Check memory count (is the brain learning?)
      try {
        const memoryService = runtime.getService<MemoryService>('itachi-memory');
        if (memoryService) {
          const stats = await memoryService.getStats();
          status.memoryCount = stats.total;
        }
      } catch (err) {
        runtime.logger.warn(`[health] Memory stats check failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 5. Phase 3B: Auto-restart on consecutive critical failures
      if (status.supabase === 'error') {
        consecutiveCriticalFailures++;
        runtime.logger.warn(`[health] Critical failure #${consecutiveCriticalFailures}/${AUTO_RESTART_THRESHOLD}`);

        if (
          consecutiveCriticalFailures >= AUTO_RESTART_THRESHOLD &&
          Date.now() - lastAutoRestart > AUTO_RESTART_COOLDOWN_MS
        ) {
          runtime.logger.error(`[health] ${AUTO_RESTART_THRESHOLD} consecutive critical failures — triggering auto-restart`);
          if (topicsService) {
            await topicsService.sendMessageWithKeyboard(
              `[Health] ${AUTO_RESTART_THRESHOLD} consecutive critical failures detected. Triggering auto-restart via Coolify...`,
              [],
            ).catch(() => {});
          }

          // Attempt Coolify API restart via SSH
          try {
            const sshService = runtime.getService<SSHService>('ssh');
            if (sshService?.getTarget('coolify')) {
              const coolifyApiToken = String(runtime.getSetting('COOLIFY_API_TOKEN') || '3|coolify-bot-token-2026');
              const coolifyAppUuid = String(runtime.getSetting('COOLIFY_RESOURCE_UUID') || 'swoo0o4okwk8ocww4g4ks084');
              const curlCmd = `curl -s -X POST "http://localhost:8000/api/v1/applications/${coolifyAppUuid}/restart" -H "Authorization: Bearer ${coolifyApiToken}"`;
              const result = await sshService.exec('coolify', curlCmd, 30_000);
              lastAutoRestart = Date.now();
              consecutiveCriticalFailures = 0;
              runtime.logger.info(`[health] Auto-restart triggered: ${result.stdout?.substring(0, 200) || 'no output'}`);
            }
          } catch (err) {
            runtime.logger.error(`[health] Auto-restart failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else {
        // Reset counter on healthy check
        if (consecutiveCriticalFailures > 0) {
          runtime.logger.info(`[health] Critical failure counter reset (was ${consecutiveCriticalFailures})`);
          consecutiveCriticalFailures = 0;
        }
      }

      lastHealthStatus = status;
      lastHealthMonitorRun = Date.now();
    } catch (error) {
      runtime.logger.error('[health] Monitor error:', error instanceof Error ? error.message : String(error));
    }
  },
};

export async function registerHealthMonitorTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_HEALTH_MONITOR');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_HEALTH_MONITOR task already exists, skipping');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_HEALTH_MONITOR',
      description: 'System health monitoring every 60 seconds',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 60_000,
      },
      tags: ['repeat'],
    } as any);
    runtime.logger.info('Registered ITACHI_HEALTH_MONITOR repeating task (60s)');
  } catch (error: unknown) {
    runtime.logger.error('Failed to register health monitor task:', error instanceof Error ? error.message : String(error));
  }
}
