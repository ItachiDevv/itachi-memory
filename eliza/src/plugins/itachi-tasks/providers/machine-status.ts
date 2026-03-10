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
      const STALE_MS = 2 * 60 * 1000; // 2 minutes
      const lines = machines.map(m => {
        const name = m.display_name || m.machine_id;
        const projects = m.projects.length > 0 ? m.projects.join(', ') : 'any';
        const capacity = `${m.active_tasks}/${m.max_concurrent}`;
        const hbAge = m.last_heartbeat ? Math.round((now - new Date(m.last_heartbeat).getTime()) / 1000) : -1;
        const hbLabel = hbAge < 0 ? 'never' : hbAge < 60 ? `${hbAge}s ago` : hbAge < 3600 ? `${Math.round(hbAge / 60)}m ago` : `${Math.round(hbAge / 3600)}h ago`;
        // Effective status: override DB status if heartbeat is stale
        const isStale = (m.status === 'online' || m.status === 'busy') && hbAge > 0 && hbAge * 1000 > STALE_MS;
        const effectiveStatus = isStale ? 'offline (stale)' : m.status;
        return `- ${name} (${m.machine_id}): ${effectiveStatus} | ${capacity} tasks | heartbeat: ${hbLabel} | projects: ${projects} | os: ${m.os || 'unknown'}`;
      });
      const online = machines.filter(m => {
        const hbAge = m.last_heartbeat ? (now - new Date(m.last_heartbeat).getTime()) : Infinity;
        return (m.status === 'online' || m.status === 'busy') && hbAge <= STALE_MS;
      });

      return {
        text: `## Orchestrator Machines (${online.length} online, ${machines.length} total)\nIMPORTANT: A machine with heartbeat older than 2 minutes is STALE and cannot run tasks. Report effective status accurately.\n${lines.join('\n')}`,
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
