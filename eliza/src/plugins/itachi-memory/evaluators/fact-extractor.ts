import { type Evaluator, type IAgentRuntime, type Memory, type State, ModelType } from '@elizaos/core';
import { MemoryService } from '../services/memory-service.js';

export const factExtractorEvaluator: Evaluator = {
  name: 'FACT_EXTRACTOR',
  description: 'Extract personal facts, preferences, and project details from Telegram conversations',
  similes: ['extract facts', 'remember preferences', 'store personal details'],
  alwaysRun: true,

  examples: [
    {
      prompt: 'User said "My name is Thomas and I work on PolyFi" and Itachi acknowledged.',
      response: 'Extracted 2 facts: user name is Thomas, user works on PolyFi project.',
    },
    {
      prompt: 'User said "thanks for the help" and Itachi replied "anytime".',
      response: 'No facts extracted — casual exchange with no reusable information.',
    },
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    // Only process Telegram messages
    if (message.content?.source !== 'telegram') return false;

    // Only trigger on agent responses (same gate as CONVERSATION_MEMORY)
    if (message.entityId !== message.agentId) return false;

    // Skip very short messages
    if ((message.content?.text || '').length < 30) return false;

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
        runtime.logger.warn('FACT_EXTRACTOR: MemoryService not available');
        return;
      }

      // Gather recent conversation context (last 4 messages)
      const recentMessages = state?.data?.recentMessages || [];
      const context = Array.isArray(recentMessages)
        ? recentMessages
            .slice(-4)
            .map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)
            .join('\n')
        : '';

      const currentMessage = message.content?.text || '';

      const prompt = `You are extracting factual information from a conversation between a user and Itachi (an AI assistant).

Recent conversation:
${context}

Current response:
${currentMessage}

Extract any concrete, reusable facts from this exchange. These include:
- Personal details (name, location, timezone, role, company)
- Preferences (tools, languages, frameworks, workflows)
- Project details (names, tech stack, architecture decisions)
- Decisions made or plans stated
- Relationships between people or projects

Rules:
- Only include concrete, specific, reusable facts — NOT greetings, thanks, or filler
- Each fact should be a standalone statement that makes sense without context
- Include the relevant project name if one is mentioned
- Return an empty array if no facts are present

Respond ONLY with valid JSON, no markdown fences:
[{"fact": "...", "project": "..."}]`;

      const result = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.1,
      });

      const raw = typeof result === 'string' ? result : String(result);
      let parsed: Array<{ fact: string; project?: string }>;
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        runtime.logger.warn('FACT_EXTRACTOR: unparseable LLM output');
        return;
      }

      if (!Array.isArray(parsed) || parsed.length === 0) return;

      let stored = 0;
      for (const item of parsed) {
        if (!item.fact || item.fact.length < 5) continue;
        const result = await memoryService.storeFact(item.fact, item.project || 'general');
        if (result) stored++;
      }

      if (stored > 0) {
        runtime.logger.info(`FACT_EXTRACTOR: stored ${stored} new fact(s) from ${parsed.length} extracted`);
      }
    } catch (error) {
      runtime.logger.error('FACT_EXTRACTOR error:', error);
    }
  },
};
