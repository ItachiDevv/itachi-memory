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
        const { machine_id, display_name, projects, max_concurrent, os, specs, engine_priority, health_url } = body;

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
          engine_priority: Array.isArray(engine_priority) ? engine_priority : undefined,
          health_url: typeof health_url === 'string' ? health_url : undefined,
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

  // Get engine priority for a machine (used by wrapper auto-fallback scripts)
  // Query: ?machine_id=<id> or ?hostname=<name>
  {
    type: 'GET',
    path: '/api/machines/engine-priority',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const registry = getRegistryService(rt, res);
        if (!registry) return;

        const query = req.query as Record<string, string> | undefined;
        const machineId = query?.machine_id || query?.hostname;

        if (!machineId) {
          res.status(400).json({ error: 'machine_id or hostname query parameter required' });
          return;
        }

        const machine = await registry.getMachine(machineId);
        const defaultPriority = ['claude', 'codex', 'gemini'];

        if (!machine) {
          // Machine not registered — return default priority
          res.json({ engine_priority: defaultPriority, source: 'default' });
          return;
        }

        const priority = Array.isArray(machine.engine_priority) && machine.engine_priority.length > 0
          ? machine.engine_priority
          : defaultPriority;

        res.json({ engine_priority: priority, source: 'machine_registry' });
      } catch (error) {
        (runtime as IAgentRuntime).logger.error('Engine priority lookup error:', error instanceof Error ? error.message : String(error));
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

  // Update engine priority for a machine
  {
    type: 'PUT' as any,
    path: '/api/machines/:id/engines',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const registry = getRegistryService(rt, res);
        if (!registry) return;

        const id = (req.params as any)?.id;
        const body = req.body as Record<string, any>;
        const { engine_priority } = body;

        if (!id || !Array.isArray(engine_priority)) {
          res.status(400).json({ error: 'Machine ID and engine_priority (string[]) required' });
          return;
        }

        const valid = engine_priority.filter((e: string) => ['claude', 'codex', 'gemini'].includes(e));
        if (valid.length === 0) {
          res.status(400).json({ error: 'At least one valid engine required (claude, codex, gemini)' });
          return;
        }

        const machine = await registry.updateEnginePriority(id, valid);
        res.json({ success: true, machine });
      } catch (error) {
        (runtime as IAgentRuntime).logger.error('Engine priority update error:', error instanceof Error ? error.message : String(error));
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  },

  // Proxy: exec command on a machine via its health_url
  {
    type: 'POST',
    path: '/api/machines/:id/exec',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const registry = getRegistryService(rt, res);
        if (!registry) return;

        const id = (req.params as any)?.id;
        const machine = await registry.getMachine(id);
        if (!machine) {
          res.status(404).json({ error: 'Machine not found' });
          return;
        }
        if (!machine.health_url) {
          res.status(400).json({ error: 'Machine has no health_url configured' });
          return;
        }

        const body = req.body as Record<string, any>;
        const proxyUrl = `${machine.health_url}/exec`;
        const apiKey = rt.getSetting('ITACHI_API_KEY');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const proxyRes = await fetch(proxyUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        const data = await proxyRes.json();
        res.status(proxyRes.status).json(data);
      } catch (error) {
        res.status(502).json({ error: 'Failed to reach machine' });
      }
    },
  },

  // Proxy: pull & rebuild on a machine
  {
    type: 'POST',
    path: '/api/machines/:id/pull',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const registry = getRegistryService(rt, res);
        if (!registry) return;

        const id = (req.params as any)?.id;
        const machine = await registry.getMachine(id);
        if (!machine) {
          res.status(404).json({ error: 'Machine not found' });
          return;
        }
        if (!machine.health_url) {
          res.status(400).json({ error: 'Machine has no health_url configured' });
          return;
        }

        const proxyUrl = `${machine.health_url}/pull`;
        const apiKey = rt.getSetting('ITACHI_API_KEY');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const proxyRes = await fetch(proxyUrl, { method: 'POST', headers });
        const data = await proxyRes.json();
        res.status(proxyRes.status).json(data);
      } catch (error) {
        res.status(502).json({ error: 'Failed to reach machine' });
      }
    },
  },

  // Proxy: restart orchestrator on a machine
  {
    type: 'POST',
    path: '/api/machines/:id/restart',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const registry = getRegistryService(rt, res);
        if (!registry) return;

        const id = (req.params as any)?.id;
        const machine = await registry.getMachine(id);
        if (!machine) {
          res.status(404).json({ error: 'Machine not found' });
          return;
        }
        if (!machine.health_url) {
          res.status(400).json({ error: 'Machine has no health_url configured' });
          return;
        }

        const proxyUrl = `${machine.health_url}/restart`;
        const apiKey = rt.getSetting('ITACHI_API_KEY');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const proxyRes = await fetch(proxyUrl, { method: 'POST', headers });
        const data = await proxyRes.json();
        res.status(proxyRes.status).json(data);
      } catch (error) {
        res.status(502).json({ error: 'Failed to reach machine' });
      }
    },
  },
];
