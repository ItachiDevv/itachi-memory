import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { MemoryService } from '../services/memory-service.js';

export const storeMemoryAction: Action = {
  name: 'STORE_MEMORY',
  description: 'Store a project memory (code change, fact, decision, etc.)',
  similes: ['remember this', 'save memory', 'store this fact', 'note this'],
  examples: [
    [
      { name: 'user', content: { text: 'Remember that the API uses JWT tokens with 24h expiry' } },
      { name: 'Itachi', content: { text: 'Stored as a fact for the project.' } },
    ],
    [
      { name: 'user', content: { text: 'Note: we switched from REST to GraphQL in api-service' } },
      { name: 'Itachi', content: { text: 'Stored: api-service switched from REST to GraphQL.' } },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() || '';
    return (
      text.includes('remember') ||
      text.includes('note') ||
      text.includes('store') ||
      text.includes('save') ||
      text.length > 20 // Any substantial message could be worth storing
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!memoryService) {
        return { success: false, error: 'Memory service not available' };
      }

      const text = message.content?.text || '';
      const stored = await memoryService.storeFact(text, 'general');

      if (!stored) {
        if (callback) {
          await callback({ text: 'I already know that — a similar fact is stored.' });
        }
        return { success: true, data: { duplicate: true } };
      }

      if (callback) {
        await callback({ text: `Stored as a fact (${stored.id.substring(0, 8)}).` });
      }

      return {
        success: true,
        data: { memoryId: stored.id, project: stored.project },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  },
};
