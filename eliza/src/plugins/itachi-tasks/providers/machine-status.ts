import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { SSHService } from '../services/ssh-service.js';

// TODO: revisit after orchestrator migration — was using MachineRegistryService

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
      // Use SSH targets as a lightweight machine list since MachineRegistryService was removed
      const sshService = runtime.getService<SSHService>('ssh');
      if (!sshService) {
        return { text: '## Orchestrator Machines\nSSH service unavailable.', values: {}, data: {} };
      }
      const targets = [...sshService.getTargets().keys()];
      if (targets.length === 0) {
        return {
          text: '## Orchestrator Machines\nNo SSH targets configured.',
          values: { machineCount: '0', onlineMachines: '0' },
          data: { machines: [] },
        };
      }

      const lines = targets.map(t => `- ${t}: configured (SSH target)`);

      return {
        text: `## Orchestrator Machines (${targets.length} configured)\n${lines.join('\n')}`,
        values: {
          machineCount: String(targets.length),
          onlineMachines: String(targets.length),
        },
        data: { machines: targets.map(t => ({ machine_id: t })) },
      };
    } catch (error) {
      runtime.logger.error('machineStatusProvider error:', error instanceof Error ? error.message : String(error));
      return { text: '## Orchestrator Machines\nFailed to load machine data.', values: {}, data: {} };
    }
  },
};
