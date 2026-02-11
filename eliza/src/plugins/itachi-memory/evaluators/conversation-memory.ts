import { type Evaluator, type IAgentRuntime, type Memory, type State, ModelType } from '@elizaos/core';
import { MemoryService } from '../services/memory-service.js';

/**
 * Combined conversation memory + fact extraction evaluator.
 * Single LLM call per Telegram message scores significance, extracts summary,
 * and pulls out concrete facts — replacing two separate evaluators.
 */
export const conversationMemoryEvaluator: Evaluator = {
  name: 'CONVERSATION_MEMORY',
  description: 'Score Telegram conversations for significance, extract summary and facts in a single LLM call',
  similes: ['remember conversation', 'store chat context', 'extract facts'],
  alwaysRun: true,

  examples: [
    {
      prompt: 'User asked about PostgreSQL migration decision and Itachi confirmed the approach.',
      response: 'Stored conversation memory with significance 0.85 and extracted 1 fact.',
    },
    {
      prompt: 'User said "thanks" and Itachi replied "you\'re welcome".',
      response: 'Stored conversation memory with significance 0.1, no facts extracted.',
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

      // Single LLM call: significance + summary + facts
      const prompt = `You are analyzing a conversation between a user and Itachi (an AI project manager).

Recent conversation:
${context}

Current response:
${currentMessage}

Do TWO things:

1. Score this exchange 0.0-1.0 for long-term significance:
   - 0.0-0.2: Greetings, thanks, acknowledgments, small talk
   - 0.3-0.5: General questions answered, status updates, minor clarifications
   - 0.6-0.8: Technical decisions, preferences expressed, important context shared
   - 0.9-1.0: Critical decisions, architectural choices, project pivots, explicit "remember this"

2. Extract concrete, reusable facts (if any):
   - Personal details (name, location, timezone, role, company)
   - Preferences (tools, languages, frameworks, workflows)
   - Project details (names, tech stack, architecture decisions)
   - Decisions made or plans stated
   Return empty array if no facts are present.

3. For each fact, classify it as "identity" or "fact":
   - "identity": Core personal attributes, relationship dynamics, personality traits, communication style, deeply held preferences, life details — things that define WHO the user is and how you relate to them. These persist forever.
   - "fact": Project-specific details, technical decisions, temporary preferences, status updates — things that may change over time.

Also extract:
- A 1-2 sentence summary of the exchange
- The project name if mentioned (or "general" if none)

Respond ONLY with valid JSON, no markdown fences:
{"significance": 0.0, "summary": "...", "project": "...", "facts": [{"fact": "...", "project": "...", "tier": "identity|fact"}]}`;

      const result = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.2,
      });

      const raw = typeof result === 'string' ? result : String(result);
      let parsed: {
        significance: number;
        summary: string;
        project: string;
        facts?: Array<{ fact: string; project?: string; tier?: string }>;
      };
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        runtime.logger.warn('CONVERSATION_MEMORY: unparseable LLM output');
        return;
      }

      if (typeof parsed.significance !== 'number' || !parsed.summary) return;

      const significance = Math.max(0, Math.min(1, parsed.significance));
      const project = parsed.project || 'general';

      // Store conversation memory
      await memoryService.storeMemory({
        project,
        category: 'conversation',
        content: currentMessage,
        summary: parsed.summary,
        files: [],
        metadata: { significance, source: 'telegram' },
      });

      // Store extracted facts (deduped via storeFact)
      let factsStored = 0;
      let identityStored = 0;
      if (Array.isArray(parsed.facts) && significance >= 0.3) {
        for (const item of parsed.facts) {
          if (!item.fact || item.fact.length < 5) continue;
          // Use LLM-classified tier, or auto-promote if significance >= 0.9
          const tier = item.tier === 'identity' || significance >= 0.9 ? 'identity' : 'fact';
          const stored = await memoryService.storeFact(item.fact, item.project || project, tier);
          if (stored) {
            if (tier === 'identity') identityStored++;
            else factsStored++;
          }
        }
      }

      runtime.logger.info(
        `CONVERSATION_MEMORY: stored (significance=${significance.toFixed(2)}, project=${project}, facts=${factsStored}, identity=${identityStored})`
      );
    } catch (error) {
      runtime.logger.error('CONVERSATION_MEMORY error:', error);
    }
  },
};
