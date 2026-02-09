import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { MachineRegistryService } from '../services/machine-registry.js';

export const machineStatusProvider: Provider = {
  name: 'MACHINE_STATUS',
  description: 'Available orchestrator machines and their status',
  dynamic: true,
  position: 16,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    try {
      const registry = runtime.getService<MachineRegistryService>('machine-registry');
      if (!registry) return { text: '', values: {}, data: {} };

      const machines = await registry.getAllMachines();
      if (machines.length === 0) {
        return {
          text: '## Orchestrator Machines\nNo machines registered.',
          values: { machineCount: '0', onlineMachines: '0' },
          data: { machines: [] },
        };
      }

      const online = machines.filter(m => m.status === 'online' || m.status === 'busy');
      const lines = machines.map(m => {
        const name = m.display_name || m.machine_id;
        const projects = m.projects.length > 0 ? m.projects.join(', ') : 'any';
        const capacity = `${m.active_tasks}/${m.max_concurrent}`;
        return `- ${name} (${m.machine_id}): ${m.status} | ${capacity} tasks | projects: ${projects} | os: ${m.os || 'unknown'}`;
      });

      return {
        text: `## Orchestrator Machines (${online.length} online, ${machines.length} total)\n${lines.join('\n')}`,
        values: {
          machineCount: String(machines.length),
          onlineMachines: String(online.length),
        },
        data: { machines },
      };
    } catch (error) {
      runtime.logger.error('machineStatusProvider error:', error);
      return { text: '', values: {}, data: {} };
    }
  },
};
