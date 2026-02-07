import type { Route, IAgentRuntime } from '@elizaos/core';
import { MachineRegistryService } from '../services/machine-registry.js';

function checkAuth(
  req: any,
  res: any,
  runtime: IAgentRuntime
): boolean {
  const apiKey = runtime.getSetting('ITACHI_API_KEY');
  if (!apiKey) return true;
  const headers = req.headers || {};
  const authHeader = headers['authorization'] || headers['Authorization'];
  const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '') : '';
  if (token !== apiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function getRegistryService(runtime: IAgentRuntime, res: any): MachineRegistryService | null {
  const service = runtime.getService<MachineRegistryService>('machine-registry') as MachineRegistryService | undefined;
  if (!service) {
    res.status(503).json({ error: 'Machine registry service not available' });
    return null;
  }
  return service;
}

export const machineRoutes: Route[] = [
  // Register or update a machine
  {
    type: 'POST',
    path: '/api/machines/register',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const registry = getRegistryService(rt, res);
        if (!registry) return;

        const body = req.body as Record<string, any>;
        const { machine_id, display_name, projects, max_concurrent, os, specs } = body;

        if (!machine_id || typeof machine_id !== 'string') {
          res.status(400).json({ error: 'machine_id (string) required' });
          return;
        }

        const machine = await registry.registerMachine({
          machine_id,
          display_name,
          projects: Array.isArray(projects) ? projects : undefined,
          max_concurrent: typeof max_concurrent === 'number' ? max_concurrent : undefined,
          os: typeof os === 'string' ? os : undefined,
          specs: typeof specs === 'object' && specs ? specs : undefined,
        });

        res.json({ success: true, machine });
      } catch (error) {
        (runtime as IAgentRuntime).logger.error('Machine register error:', error instanceof Error ? error.message : String(error));
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  },

  // Heartbeat from a machine
  {
    type: 'POST',
    path: '/api/machines/heartbeat',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const registry = getRegistryService(rt, res);
        if (!registry) return;

        const body = req.body as Record<string, any>;
        const { machine_id, active_tasks } = body;

        if (!machine_id || typeof machine_id !== 'string') {
          res.status(400).json({ error: 'machine_id (string) required' });
          return;
        }

        const activeTasks = typeof active_tasks === 'number' ? active_tasks : 0;
        const machine = await registry.heartbeat(machine_id, activeTasks);

        res.json({ success: true, machine });
      } catch (error) {
        (runtime as IAgentRuntime).logger.error('Machine heartbeat error:', error instanceof Error ? error.message : String(error));
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  },

  // List all machines
  {
    type: 'GET',
    path: '/api/machines',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const registry = getRegistryService(rt, res);
        if (!registry) return;

        const machines = await registry.getAllMachines();
        res.json({ machines });
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  },

  // Get single machine details
  {
    type: 'GET',
    path: '/api/machines/:id',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const registry = getRegistryService(rt, res);
        if (!registry) return;

        const id = (req.params as any)?.id;
        if (!id) {
          res.status(400).json({ error: 'Machine ID required' });
          return;
        }

        const machine = await registry.getMachine(id);
        if (!machine) {
          res.status(404).json({ error: 'Machine not found' });
          return;
        }

        res.json({ machine });
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  },
];
