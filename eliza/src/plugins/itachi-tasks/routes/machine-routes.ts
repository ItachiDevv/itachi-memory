import type { Route } from '@elizaos/core';

// TODO: revisit after orchestrator migration — MachineRegistryService was removed
// All machine routes return 503 until the new orchestrator provides equivalent functionality.

export const machineRoutes: Route[] = [
  {
    type: 'POST',
    path: '/api/machines/register',
    public: true,
    handler: async (_req, res) => {
      res.status(503).json({ error: 'Machine registry removed — use new orchestrator' });
    },
  },
  {
    type: 'POST',
    path: '/api/machines/heartbeat',
    public: true,
    handler: async (_req, res) => {
      res.status(503).json({ error: 'Machine registry removed — use new orchestrator' });
    },
  },
  {
    type: 'GET',
    path: '/api/machines',
    public: true,
    handler: async (_req, res) => {
      res.status(503).json({ error: 'Machine registry removed — use new orchestrator' });
    },
  },
  {
    type: 'GET',
    path: '/api/machines/engine-priority',
    public: true,
    handler: async (_req, res) => {
      res.status(503).json({ error: 'Machine registry removed — use new orchestrator' });
    },
  },
  {
    type: 'GET',
    path: '/api/machines/:id',
    public: true,
    handler: async (_req, res) => {
      res.status(503).json({ error: 'Machine registry removed — use new orchestrator' });
    },
  },
  {
    type: 'PUT' as any,
    path: '/api/machines/:id/engines',
    public: true,
    handler: async (_req, res) => {
      res.status(503).json({ error: 'Machine registry removed — use new orchestrator' });
    },
  },
  {
    type: 'POST',
    path: '/api/machines/:id/exec',
    public: true,
    handler: async (_req, res) => {
      res.status(503).json({ error: 'Machine registry removed — use new orchestrator' });
    },
  },
  {
    type: 'POST',
    path: '/api/machines/:id/pull',
    public: true,
    handler: async (_req, res) => {
      res.status(503).json({ error: 'Machine registry removed — use new orchestrator' });
    },
  },
  {
    type: 'POST',
    path: '/api/machines/:id/restart',
    public: true,
    handler: async (_req, res) => {
      res.status(503).json({ error: 'Machine registry removed — use new orchestrator' });
    },
  },
];
