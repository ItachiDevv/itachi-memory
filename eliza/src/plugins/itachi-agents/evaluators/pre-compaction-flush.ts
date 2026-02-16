import type { Evaluator, IAgentRuntime, Memory, State } from '@elizaos/core';
import { ModelType } from '@elizaos/core';

/**
 * Pre-compaction memory flush evaluator.
 * Fires when conversation approaches context window limit,
 * saving undocumented insights to memory before ElizaOS compacts.
 */
export const preCompactionFlushEvaluator: Evaluator = {
  name: 'PRE_COMPACTION_FLUSH',
  description: 'Save important context to memory before conversation compaction',
  similes: ['save context', 'pre-compaction'],
  alwaysRun: true,

  examples: [
    {
      prompt: 'Monitors conversation length and saves insights before compaction',
      messages: [
        { name: 'user', content: { text: 'continue working on the feature' } },
      ],
      outcome: 'If conversation is long, extracts and persists key decisions/insights',
    },
  ],

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    // Cheap heuristic: estimate conversation length via character count
    // Only trigger when we're approaching the threshold
    const text = message.content?.text || '';
    const threshold = parseInt(runtime.getSetting('COMPACTION_FLUSH_THRESHOLD') || '80000', 10);

    // Check total conversation size by looking at recent messages
    // This is a rough heuristic — we track total chars seen
    const recentSize = getConversationSize(runtime);
    return recentSize > threshold;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<{ result?: unknown }> => {
    try {
      const memService = runtime.getService('itachi-memory') as any;
      if (!memService?.storeMemory) {
        runtime.logger.warn('[pre-compaction] MemoryService not available');
        return {};
      }

      // Build a summary of recent conversation context
      const recentContext = buildRecentContext(state);
      if (!recentContext || recentContext.length < 100) return {};

      // Extract key insights via LLM
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: `Extract the most important decisions, preferences, facts, and technical details from this conversation context that should be preserved. Focus on things that would be lost if this context were summarized.

Context:
${recentContext.slice(0, 3000)}

List the key insights (one per line, be specific):`,
        temperature: 0.2,
      });

      const insights = typeof response === 'string' ? response.trim() : '';
      if (!insights || insights.length < 20) return {};

      // Store as session insights
      await memService.storeMemory({
        project: 'itachi',
        category: 'session_insight',
        content: insights,
        summary: 'Pre-compaction context preservation',
        files: [],
        importance: 0.6,
      });

      // Reset the conversation size tracker
      resetConversationSize(runtime);

      runtime.logger.info(`[pre-compaction] Saved ${insights.length} chars of insights`);
      return { result: { saved: true, length: insights.length } };
    } catch (err) {
      runtime.logger.error('[pre-compaction] Error:', err);
      return {};
    }
  },
};

// Simple conversation size tracking via runtime-scoped counter
const conversationSizes = new WeakMap<object, number>();

function getConversationSize(runtime: IAgentRuntime): number {
  return conversationSizes.get(runtime) || 0;
}

function resetConversationSize(runtime: IAgentRuntime): void {
  conversationSizes.set(runtime, 0);
}

/** Track message sizes — called implicitly since alwaysRun=true */
function buildRecentContext(state?: State): string {
  if (!state) return '';

  // Use available state to reconstruct recent context
  const parts: string[] = [];
  if (state.recentMessages) {
    parts.push(typeof state.recentMessages === 'string' ? state.recentMessages : JSON.stringify(state.recentMessages));
  }
  if (state.goals) {
    parts.push(`Goals: ${typeof state.goals === 'string' ? state.goals : JSON.stringify(state.goals)}`);
  }

  return parts.join('\n\n');
}

// Increment conversation size when evaluator runs (via validate)
const originalValidate = preCompactionFlushEvaluator.validate;
preCompactionFlushEvaluator.validate = async (runtime, message, state) => {
  const text = message.content?.text || '';
  const current = conversationSizes.get(runtime) || 0;
  conversationSizes.set(runtime, current + text.length);
  return originalValidate!(runtime, message, state);
};
