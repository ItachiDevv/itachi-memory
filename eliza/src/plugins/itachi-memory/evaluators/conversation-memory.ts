import { type Evaluator, type IAgentRuntime, type Memory, type State, ModelType } from '@elizaos/core';
import { MemoryService } from '../services/memory-service.js';

export const conversationMemoryEvaluator: Evaluator = {
  name: 'CONVERSATION_MEMORY',
  description: 'LLM-filtered storage of Telegram conversation exchanges — only stores exchanges worth remembering long-term',
  similes: ['remember conversation', 'store chat context', 'filter conversation memory'],
  alwaysRun: true,

  examples: [
    {
      prompt: 'User decided to switch from REST to GraphQL for the new API and Itachi confirmed the migration plan.',
      response: 'Stored conversation memory: decided to migrate API from REST to GraphQL with phased rollout.',
    },
    {
      prompt: 'User said "hey" and Itachi replied "Hello! How can I help you today?".',
      response: 'Skipped — casual greeting, not worth storing long-term.',
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
    if (text.length < 50) return false;

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

      const prompt = `You are analyzing a conversation between a user and Itachi (an AI project manager) to decide if this exchange is worth remembering long-term.

Recent conversation:
${context}

Current response:
${currentMessage}

Is this exchange worth storing in long-term memory? Consider:
- Decisions, preferences, architectural choices, project context = YES
- Greetings, thanks, acknowledgments, small talk, status pings = NO
- Bug reports, error details, debugging conclusions = YES
- Simple confirmations without new information = NO

Respond ONLY with valid JSON, no markdown fences:
{"worth_storing": true, "summary": "1-2 sentence summary of what to remember", "project": "project name or general"}

If NOT worth storing:
{"worth_storing": false, "summary": "", "project": ""}`;

      const result = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.2,
      });

      const raw = typeof result === 'string' ? result : String(result);
      let parsed: { worth_storing: boolean; summary: string; project: string };
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        runtime.logger.warn('CONVERSATION_MEMORY: unparseable LLM output');
        return;
      }

      if (typeof parsed.worth_storing !== 'boolean') return;

      if (!parsed.worth_storing) {
        runtime.logger.debug('CONVERSATION_MEMORY: skipped — not worth storing');
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
        `CONVERSATION_MEMORY: stored (project=${project}, summary=${parsed.summary.substring(0, 60)})`
      );
    } catch (error) {
      runtime.logger.error('CONVERSATION_MEMORY error:', error);
    }
  },
};
