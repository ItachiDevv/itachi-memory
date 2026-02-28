import type { Plugin } from '@elizaos/core';
import { MemoryService } from './services/memory-service.js';
import { storeMemoryAction } from './actions/store-memory.js';
import { recentMemoriesProvider } from './providers/recent-memories.js';
import { memoryStatsProvider } from './providers/memory-stats.js';
import { conversationContextProvider } from './providers/conversation-context.js';
import { factsContextProvider } from './providers/facts-context.js';
import { brainStateProvider } from './providers/brain-state-provider.js';
import { conversationMemoryEvaluator } from './evaluators/conversation-memory.js';
export { transcriptIndexerWorker, registerTranscriptIndexerTask } from './workers/transcript-indexer.js';
// factExtractorEvaluator merged into conversationMemoryEvaluator (single LLM call)

export const itachiMemoryPlugin: Plugin = {
  name: 'itachi-memory',
  description: 'Project memory storage, semantic search, and fact extraction for Itachi',
  actions: [storeMemoryAction],
  evaluators: [conversationMemoryEvaluator],
  providers: [factsContextProvider, brainStateProvider, recentMemoriesProvider, memoryStatsProvider, conversationContextProvider],
  services: [MemoryService],
};
