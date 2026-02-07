import { type Evaluator, type IAgentRuntime, type Memory, type State, ModelType } from '@elizaos/core';
import { MemoryService } from '../services/memory-service.js';

export const conversationMemoryEvaluator: Evaluator = {
  name: 'CONVERSATION_MEMORY',
  description: 'Store every Telegram conversation exchange in project memory',
  similes: ['remember conversation', 'store chat context'],
  alwaysRun: true,

  examples: [
    {
      prompt: 'User asked about PostgreSQL migration decision and Itachi confirmed the approach.',
      response: 'Stored conversation memory: decided to use PostgreSQL for new project.',
    },
    {
      prompt: 'User said "hey how are you" and Itachi replied with a greeting.',
      response: 'Stored conversation memory: casual greeting exchange.',
    },
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    // Only process Telegram messages
    const source = message.content?.source;
    if (source !== 'telegram') return false;

    // Only trigger on the agent's own response (not user messages)
    const isAgentMessage = message.entityId === message.agentId;
    if (!isAgentMessage) return false;

    // Skip very short messages
    const text = message.content?.text || '';
    if (text.length < 20) return false;

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
            .slice(-4)
            .map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)
            .join('\n')
        : '';

      const currentMessage = message.content?.text || '';

      const prompt = `You are analyzing a conversation between a user and Itachi (an AI project manager).

Recent conversation:
${context}

Current response:
${currentMessage}

Summarize this exchange in 1-2 sentences. Extract the project name if any are mentioned (or "general" if none).

Respond ONLY with valid JSON, no markdown fences:
{"summary": "...", "project": "..."}`;

      const result = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.2,
      });

      const raw = typeof result === 'string' ? result : String(result);
      let parsed: { summary: string; project: string };
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        runtime.logger.warn('CONVERSATION_MEMORY: unparseable LLM output');
        return;
      }

      if (!parsed.summary) return;

      const project = parsed.project || 'general';

      await memoryService.storeMemory({
        project,
        category: 'conversation',
        content: currentMessage,
        summary: parsed.summary,
        files: [],
      });

      runtime.logger.info(
        `CONVERSATION_MEMORY: stored (project=${project})`
      );
    } catch (error) {
      runtime.logger.error('CONVERSATION_MEMORY error:', error);
    }
  },
};
