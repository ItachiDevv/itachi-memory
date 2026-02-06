import type { Plugin } from '@elizaos/core';
import { MemoryService } from './services/memory-service.js';
import { storeMemoryAction } from './actions/store-memory.js';
import { recentMemoriesProvider } from './providers/recent-memories.js';
import { memoryStatsProvider } from './providers/memory-stats.js';

export const itachiMemoryPlugin: Plugin = {
  name: 'itachi-memory',
  description: 'Project memory storage, semantic search, and fact extraction for Itachi',
  actions: [storeMemoryAction],
  providers: [recentMemoriesProvider, memoryStatsProvider],
  services: [MemoryService],
};
