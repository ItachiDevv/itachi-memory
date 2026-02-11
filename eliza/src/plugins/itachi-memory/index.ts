import type { Plugin } from '@elizaos/core';
import { MemoryService } from './services/memory-service.js';
import { storeMemoryAction } from './actions/store-memory.js';
import { recentMemoriesProvider } from './providers/recent-memories.js';
import { memoryStatsProvider } from './providers/memory-stats.js';
import { conversationContextProvider } from './providers/conversation-context.js';
import { factsContextProvider } from './providers/facts-context.js';
import { conversationMemoryEvaluator } from './evaluators/conversation-memory.js';
import { factExtractorEvaluator } from './evaluators/fact-extractor.js';

export const itachiMemoryPlugin: Plugin = {
  name: 'itachi-memory',
  description: 'Project memory storage, semantic search, and fact extraction for Itachi',
  actions: [storeMemoryAction],
  evaluators: [conversationMemoryEvaluator, factExtractorEvaluator],
  providers: [factsContextProvider, recentMemoriesProvider, memoryStatsProvider, conversationContextProvider],
  services: [MemoryService],
};
