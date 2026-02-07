import { type TaskWorker, type IAgentRuntime } from '@elizaos/core';
import { MachineRegistryService } from '../services/machine-registry.js';
import { TaskService } from '../services/task-service.js';

/**
 * Task dispatcher: runs every 10 seconds.
 * - Assigns unassigned queued tasks to the best available machine.
 * - Detects stale machines (no heartbeat > 120s) and marks them offline.
 * - Unassigns tasks from offline machines so they can be reassigned.
 */
export const taskDispatcherWorker: TaskWorker = {
  name: 'ITACHI_TASK_DISPATCHER',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => true,

  execute: async (runtime: IAgentRuntime): Promise<void> => {
    try {
      const registry = runtime.getService<MachineRegistryService>('machine-registry');
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      if (!registry || !taskService) {
        return; // Services not available yet, skip silently
      }

      // 1. Mark stale machines offline (no heartbeat in 120s)
      const staleIds = await registry.markStaleMachinesOffline(120_000);
      if (staleIds.length > 0) {
        runtime.logger.info(`[dispatcher] Marked ${staleIds.length} stale machine(s) offline: ${staleIds.join(', ')}`);

        // Unassign queued tasks from offline machines
        for (const machineId of staleIds) {
          const unassigned = await registry.unassignTasksFromMachine(machineId);
          if (unassigned > 0) {
            runtime.logger.info(`[dispatcher] Unassigned ${unassigned} task(s) from offline machine ${machineId}`);
          }
        }
      }

      // 2. Get unassigned queued tasks
      const supabase = taskService.getSupabase();
      const { data: unassignedTasks, error } = await supabase
        .from('itachi_tasks')
        .select('id, project')
        .eq('status', 'queued')
        .is('assigned_machine', null)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(10);

      if (error || !unassignedTasks || unassignedTasks.length === 0) {
        return; // Nothing to dispatch
      }

      // 3. Assign each task to the best available machine
      for (const task of unassignedTasks) {
        const machine = await registry.getMachineForProject(task.project);
        if (!machine) {
          // No machine available; task stays unassigned for next cycle
          continue;
        }

        await registry.assignTask(task.id, machine.machine_id);
        const shortId = task.id.substring(0, 8);
        runtime.logger.info(`[dispatcher] Assigned task ${shortId} (${task.project}) to ${machine.machine_id}`);
      }
    } catch (error) {
      runtime.logger.error('[dispatcher] Error:', error instanceof Error ? error.message : String(error));
    }
  },
};

export async function registerTaskDispatcherTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_TASK_DISPATCHER');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_TASK_DISPATCHER task already exists, skipping');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_TASK_DISPATCHER',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 10 * 1000, // 10 seconds
      },
      tags: ['repeat'],
    });
    runtime.logger.info('Registered ITACHI_TASK_DISPATCHER repeating task (10s)');
  } catch (error) {
    runtime.logger.error('Failed to register task dispatcher task:', error);
  }
}
