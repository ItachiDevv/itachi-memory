import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { MachineRegistryService } from '../services/machine-registry.js';

export const machineStatusProvider: Provider = {
  name: 'MACHINE_STATUS',
  description: 'Available orchestrator machines and their status',
  dynamic: false,
  position: 16,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    try {
      const registry = runtime.getService<MachineRegistryService>('machine-registry');
      if (!registry) return { text: '## Orchestrator Machines\nMachine registry unavailable. Do NOT guess about machine status.', values: {}, data: {} };

      const machines = await registry.getAllMachines();
      if (machines.length === 0) {
        return {
          text: '## Orchestrator Machines\nNo machines registered.',
          values: { machineCount: '0', onlineMachines: '0' },
          data: { machines: [] },
        };
      }

      const now = Date.now();
      const STALE_THRESHOLD_MS = 120_000; // 2 minutes — matches task dispatcher threshold

      // Compute effective status: override DB status to 'offline' if heartbeat is stale
      const machinesWithEffectiveStatus = machines.map(m => {
        const hbAge = m.last_heartbeat ? now - new Date(m.last_heartbeat).getTime() : Infinity;
        const isStale = hbAge > STALE_THRESHOLD_MS;
        const effectiveStatus = (m.status === 'online' || m.status === 'busy') && isStale ? 'offline (stale)' : m.status;
        return { ...m, effectiveStatus, hbAge };
      });

      const online = machinesWithEffectiveStatus.filter(m => m.effectiveStatus === 'online' || m.effectiveStatus === 'busy');
      const lines = machinesWithEffectiveStatus.map(m => {
        const name = m.display_name || m.machine_id;
        const projects = m.projects.length > 0 ? m.projects.join(', ') : 'any';
        const capacity = `${m.active_tasks}/${m.max_concurrent}`;
        const hbAgeSec = m.hbAge === Infinity ? -1 : Math.round(m.hbAge / 1000);
        const hbLabel = hbAgeSec < 0 ? 'never' : hbAgeSec < 60 ? `${hbAgeSec}s ago` : hbAgeSec < 3600 ? `${Math.round(hbAgeSec / 60)}m ago` : `${Math.round(hbAgeSec / 3600)}h ago`;
        return `- ${name} (${m.machine_id}): ${m.effectiveStatus} | ${capacity} tasks | heartbeat: ${hbLabel} | projects: ${projects} | os: ${m.os || 'unknown'}`;
      });

      return {
        text: `## Orchestrator Machines (${online.length} online, ${machines.length} total)\nIMPORTANT: Machines with heartbeat older than 2 minutes are OFFLINE and cannot run tasks. Do NOT route commands to offline machines.\n${lines.join('\n')}`,
        values: {
          machineCount: String(machines.length),
          onlineMachines: String(online.length),
        },
        data: { machines },
      };
    } catch (error) {
      runtime.logger.error('machineStatusProvider error:', error instanceof Error ? error.message : String(error));
      return { text: '## Orchestrator Machines\nFailed to load machine data. Do NOT make up machine statuses.', values: {}, data: {} };
    }
  },
};
