import { type TaskWorker, type IAgentRuntime } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';
import { MachineRegistryService } from '../services/machine-registry.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';

/**
 * Proactive monitor: runs every 5 minutes.
 * - Detects failed tasks not yet retried and suggests retry.
 * - Detects stale running tasks (>1 hour) and alerts.
 * - Checks machine connectivity and alerts on newly-offline machines.
 * - Sends notifications to the Telegram group General thread.
 */

const STALE_TASK_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
const MONITOR_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Track state between runs to avoid spamming the same alerts
const alertedTaskIds = new Set<string>();
const alertedMachineIds = new Set<string>();

export const proactiveMonitorWorker: TaskWorker = {
  name: 'ITACHI_PROACTIVE_MONITOR',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => true,

  execute: async (runtime: IAgentRuntime): Promise<void> => {
    try {
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      const registry = runtime.getService<MachineRegistryService>('machine-registry');
      if (!taskService || !registry) return;

      const botToken = String(runtime.getSetting('TELEGRAM_BOT_TOKEN') || '');
      const chatId = String(runtime.getSetting('TELEGRAM_GROUP_CHAT_ID') || process.env.TELEGRAM_GROUP_CHAT_ID || '');
      if (!botToken || !chatId) return;

      const alerts: string[] = [];

      // 1. Check for failed tasks not yet retried (completed recently)
      const recentTasks = await taskService.listTasks({ limit: 20 });
      const failedTasks = recentTasks.filter(t =>
        t.status === 'failed' &&
        !alertedTaskIds.has(t.id) &&
        t.completed_at &&
        Date.now() - new Date(t.completed_at).getTime() < MONITOR_INTERVAL_MS * 2
      );

      for (const task of failedTasks) {
        const shortId = task.id.substring(0, 8);
        const errMsg = task.error_message ? `: ${task.error_message.substring(0, 80)}` : '';
        alerts.push(`⚠️ Task ${shortId} (${task.project}) failed${errMsg}\nRetry: /task ${task.project} ${task.description.substring(0, 100)}`);
        alertedTaskIds.add(task.id);
      }

      // 2. Check for stale running tasks (running > 1 hour without completion)
      const activeTasks = await taskService.getActiveTasks();
      const staleTasks = activeTasks.filter(t =>
        (t.status === 'running' || t.status === 'claimed') &&
        !alertedTaskIds.has(t.id) &&
        t.started_at &&
        Date.now() - new Date(t.started_at).getTime() > STALE_TASK_THRESHOLD_MS
      );

      for (const task of staleTasks) {
        const shortId = task.id.substring(0, 8);
        const runTime = Math.round((Date.now() - new Date(task.started_at!).getTime()) / 60000);
        alerts.push(`🕐 Task ${shortId} (${task.project}) has been running for ${runTime}m. Might be stalled.\nCancel: /cancel ${shortId}`);
        alertedTaskIds.add(task.id);
      }

      // 3. Check machine connectivity
      const machines = await registry.getAllMachines();
      for (const machine of machines) {
        const name = machine.display_name || machine.machine_id;
        if (machine.status === 'offline' && !alertedMachineIds.has(machine.machine_id)) {
          // Only alert if machine was recently online (last heartbeat within 30 min)
          if (machine.last_heartbeat) {
            const timeSince = Date.now() - new Date(machine.last_heartbeat).getTime();
            if (timeSince < 30 * 60 * 1000) {
              alerts.push(`🔴 Machine ${name} went offline (last heartbeat: ${Math.round(timeSince / 60000)}m ago)`);
              alertedMachineIds.add(machine.machine_id);
            }
          }
        } else if (machine.status === 'online' || machine.status === 'busy') {
          // Machine came back online — remove from alerted set
          alertedMachineIds.delete(machine.machine_id);
        }
      }

      // 4. Check for queued tasks with no machines online
      const queuedTasks = activeTasks.filter(t => t.status === 'queued');
      const onlineMachines = machines.filter(m => m.status === 'online' || m.status === 'busy');
      if (queuedTasks.length > 0 && onlineMachines.length === 0) {
        const key = `no-machines-${queuedTasks.length}`;
        if (!alertedTaskIds.has(key)) {
          alerts.push(`📭 ${queuedTasks.length} task(s) queued but no machines online. Start an orchestrator to process them.`);
          alertedTaskIds.add(key);
        }
      }

      // Send alerts if any
      if (alerts.length > 0) {
        const message = `🔍 Monitor Alert\n\n${alerts.join('\n\n')}`;
        await sendTelegramMessage(botToken, chatId, message);
        runtime.logger.info(`[monitor] Sent ${alerts.length} alert(s)`);
      }

      // Clean up old alerted IDs (keep set from growing unbounded)
      if (alertedTaskIds.size > 200) {
        const entries = [...alertedTaskIds];
        entries.slice(0, 100).forEach(id => alertedTaskIds.delete(id));
      }
    } catch (error) {
      runtime.logger.error('[monitor] Error:', error instanceof Error ? error.message : String(error));
    }
  },
};

async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }),
  });
}

export async function registerProactiveMonitorTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_PROACTIVE_MONITOR');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_PROACTIVE_MONITOR task already exists, skipping');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_PROACTIVE_MONITOR',
      description: 'Proactive monitor for failed tasks, stale tasks, and machine connectivity',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: MONITOR_INTERVAL_MS,
      },
      tags: ['repeat'],
    } as any);
    runtime.logger.info(`Registered ITACHI_PROACTIVE_MONITOR repeating task (${MONITOR_INTERVAL_MS / 1000}s)`);
  } catch (error: unknown) {
    runtime.logger.error('Failed to register proactive monitor task:', error instanceof Error ? error.message : String(error));
  }
}
