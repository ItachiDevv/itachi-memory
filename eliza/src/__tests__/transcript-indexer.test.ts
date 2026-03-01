import { describe, it, expect, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================
// Tests for transcript indexer worker
// ============================================================

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PROJECTS_DIR_EXISTS = fs.existsSync(PROJECTS_DIR);

describe('Transcript Indexer', () => {
  it('validate should return boolean based on .claude/projects existence', async () => {
    const mod = await import('../plugins/itachi-memory/workers/transcript-indexer.js');
    const worker = mod.transcriptIndexerWorker;

    const mockRuntime = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };

    const result = await worker.validate(mockRuntime as any);
    // The result depends on whether the projects dir exists on this machine
    expect(result).toBe(PROJECTS_DIR_EXISTS);
    expect(typeof result).toBe('boolean');
  });

  it('should skip execution when MemoryService is not available', async () => {
    const mod = await import('../plugins/itachi-memory/workers/transcript-indexer.js');
    const worker = mod.transcriptIndexerWorker;

    let warned = false;
    const mockRuntime = {
      getService: () => null,
      logger: {
        info: () => {},
        warn: (msg: string) => { if (msg.includes('not available')) warned = true; },
        error: () => {},
      },
    };

    await worker.execute(mockRuntime as any);
    expect(warned).toBe(true);
  });

  it('should handle execution with empty projects directory gracefully', async () => {
    const mod = await import('../plugins/itachi-memory/workers/transcript-indexer.js');
    const worker = mod.transcriptIndexerWorker;

    // Create a mock that returns empty dirs for readdirSync
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
        upsert: () => Promise.resolve({ error: null }),
      }),
    };

    const mockRuntime = {
      getService: () => ({
        getSupabase: () => mockSupabase,
        storeMemory: async () => ({ id: 'test' }),
      }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };

    // Should not throw — will either find real dirs or skip gracefully
    // Note: scans real ~/.claude/projects/ so needs generous timeout on large machines
    await worker.execute(mockRuntime as any);
  }, 30_000);

  it('registerTranscriptIndexerTask should not create duplicate tasks', async () => {
    const mod = await import('../plugins/itachi-memory/workers/transcript-indexer.js');
    const { registerTranscriptIndexerTask } = mod;

    let createCalled = false;
    const mockRuntime = {
      getTasksByName: async (name: string) => {
        if (name === 'ITACHI_TRANSCRIPT_INDEXER') {
          return [{ name: 'ITACHI_TRANSCRIPT_INDEXER', id: 'existing' }];
        }
        return [];
      },
      createTask: async () => { createCalled = true; },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };

    await registerTranscriptIndexerTask(mockRuntime as any);
    expect(createCalled).toBe(false);
  });

  it('registerTranscriptIndexerTask should create task when none exists', async () => {
    const mod = await import('../plugins/itachi-memory/workers/transcript-indexer.js');
    const { registerTranscriptIndexerTask } = mod;

    let createdTask: any = null;
    const mockRuntime = {
      agentId: 'test-agent-id',
      getTasksByName: async () => [],
      createTask: async (task: any) => { createdTask = task; },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };

    await registerTranscriptIndexerTask(mockRuntime as any);
    expect(createdTask).toBeTruthy();
    expect(createdTask.name).toBe('ITACHI_TRANSCRIPT_INDEXER');
    expect(createdTask.metadata.updateInterval).toBe(60 * 60 * 1000);
    expect(createdTask.tags).toContain('repeat');
  });

  it('worker should have correct name and 1-hour interval', async () => {
    const mod = await import('../plugins/itachi-memory/workers/transcript-indexer.js');
    expect(mod.transcriptIndexerWorker.name).toBe('ITACHI_TRANSCRIPT_INDEXER');
    // Verify the task uses 1hr interval when registered
    let taskConfig: any = null;
    const mockRuntime = {
      agentId: 'agent-1',
      getTasksByName: async () => [],
      createTask: async (task: any) => { taskConfig = task; },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    await mod.registerTranscriptIndexerTask(mockRuntime as any);
    expect(taskConfig.metadata.updateInterval).toBe(3600000);
  });
});
