import { type Evaluator, type IAgentRuntime, type Memory, type State, ModelType } from '@elizaos/core';
import { MemoryService } from '../services/memory-service.js';

export const conversationMemoryEvaluator: Evaluator = {
  name: 'CONVERSATION_MEMORY',
  description: 'Store Telegram conversation exchanges in project memory with significance scoring',
  similes: ['remember conversation', 'store chat context'],
  alwaysRun: true,

  examples: [
    {
      prompt: 'User asked about PostgreSQL migration decision and Itachi confirmed the approach.',
      response: 'Stored conversation memory with significance 0.85: decided to use PostgreSQL for new project.',
    },
    {
      prompt: 'User said "thanks" and Itachi replied "you\'re welcome".',
      response: 'Stored conversation memory with significance 0.1: casual exchange.',
    },
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    // Only process Telegram messages
    const source = message.content?.source;
    if (source !== 'telegram') return false;

    // Only trigger on the agent's own response (not user messages)
    // In ElizaOS, the agent's entityId matches the runtime agent
    const isAgentMessage = message.entityId === message.agentId;
    if (!isAgentMessage) return false;

    // Skip very short messages
    const text = message.content?.text || '';
    if (text.length < 30) return false;

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ): Promise<void> => {
    try {
      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!memoryService) {
        runtime.logger.warn('CONVERSATION_MEMORY: MemoryService not available');
        return;
      }

      // Gather recent conversation context
      const recentMessages = state?.data?.recentMessages || [];
      const context = Array.isArray(recentMessages)
        ? recentMessages
            .slice(-6)
            .map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)
            .join('\n')
        : '';

      const currentMessage = message.content?.text || '';

      const prompt = `You are analyzing a conversation between a user and Itachi (an AI project manager) to determine its long-term significance and extract a summary.

Recent conversation:
${context}

Current response:
${currentMessage}

Score this exchange 0.0-1.0 for long-term significance:
- 0.0-0.2: Greetings, thanks, acknowledgments, small talk
- 0.3-0.5: General questions answered, status updates, minor clarifications
- 0.6-0.8: Technical decisions, preferences expressed, important context shared
- 0.9-1.0: Critical decisions, architectural choices, project pivots, explicit "remember this"

Also extract:
- A 1-2 sentence summary of the exchange
- The project name if mentioned (or "general" if none)

Respond ONLY with valid JSON, no markdown fences:
{"significance": 0.0, "summary": "...", "project": "..."}`;

      const result = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.2,
      });

      const raw = typeof result === 'string' ? result : String(result);
      let parsed: { significance: number; summary: string; project: string };
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        runtime.logger.warn('CONVERSATION_MEMORY: unparseable LLM output');
        return;
      }

      if (typeof parsed.significance !== 'number' || !parsed.summary) return;

      const significance = Math.max(0, Math.min(1, parsed.significance));
      const project = parsed.project || 'general';

      await memoryService.storeMemory({
        project,
        category: 'conversation',
        content: currentMessage,
        summary: parsed.summary,
        files: [],
        metadata: { significance, source: 'telegram' },
      });

      runtime.logger.info(
        `CONVERSATION_MEMORY: stored (significance=${significance.toFixed(2)}, project=${project})`
      );
    } catch (error) {
      runtime.logger.error('CONVERSATION_MEMORY error:', error);
    }
  },
};
