import { type Evaluator, type IAgentRuntime, type Memory, type State, ModelType } from '@elizaos/core';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';

// Track message count to only run every ~10 messages
let messagesSinceLastExtraction = 0;
const EXTRACTION_INTERVAL = 10;

export const personalityExtractor: Evaluator = {
  name: 'PERSONALITY_EXTRACTOR',
  description: 'Extract personality traits from user communication patterns',
  similes: ['learn personality', 'communication style'],
  alwaysRun: true,

  examples: [
    {
      prompt: 'Analyze user communication patterns for personality traits.',
      messages: [
        { name: 'user', content: { text: 'just ship it, dont overthink' } },
      ],
      outcome: 'Extracted: user prefers speed over perfection, casual communication style',
    },
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    // Only process user messages with meaningful text
    const text = message.content?.text || '';
    if (text.length < 10) return false;

    messagesSinceLastExtraction++;
    if (messagesSinceLastExtraction < EXTRACTION_INTERVAL) return false;
    messagesSinceLastExtraction = 0;
    return true;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<void> => {
    try {
      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!memoryService) return;

      // Collect recent user messages for pattern analysis
      const recentMessages = state?.data?.recentMessages || [];
      const userMessages = Array.isArray(recentMessages)
        ? recentMessages
            .filter((m: any) => (m.role || m.user || '').toLowerCase() === 'user' || (m.role || m.user || '').toLowerCase() === 'human')
            .slice(-10)
            .map((m: any) => typeof m.content === 'string' ? m.content : (m.content?.text || m.text || ''))
            .filter((t: string) => t.length > 5)
        : [];

      const currentText = message.content?.text || '';
      userMessages.push(currentText);

      if (userMessages.length < 3) return; // Need enough messages for pattern detection

      const prompt = `Analyze these user messages to extract personality and communication traits.

User messages (most recent):
${userMessages.slice(-8).map((m: string, i: number) => `${i + 1}. "${m}"`).join('\n')}

Extract traits in these categories:
- communication_tone: formal/casual/terse/verbose/technical
- decision_style: cautious/bold, collaborative/autonomous, data-driven/intuitive
- priority_signals: what the user cares about (speed, quality, cost, learning)
- vocabulary_patterns: distinctive words/phrases the user frequently uses

Return a JSON array of distinct traits. Each trait must have:
- "text": concise trait description (1 sentence)
- "category": one of the categories above
- "confidence": 0.0-1.0

Only include confident observations (0.6+). If no clear traits, return [].
Respond ONLY with valid JSON array, no markdown fences.`;

      const result = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.3,
      });

      const raw = typeof result === 'string' ? result : String(result);
      let traits: Array<{ text: string; category: string; confidence: number }>;
      try {
        const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        traits = JSON.parse(cleaned);
      } catch {
        return;
      }

      if (!Array.isArray(traits)) return;

      let storedCount = 0;
      for (const trait of traits) {
        if (!trait.text || trait.text.length < 10 || !trait.category) continue;
        if (typeof trait.confidence !== 'number' || trait.confidence < 0.6) continue;

        // Dedup: check for similar existing trait
        try {
          const existing = await memoryService.searchMemories(
            trait.text, undefined, 1, undefined, 'personality_trait'
          );
          if (existing.length > 0 && (existing[0].similarity ?? 0) > 0.9) {
            // Reinforce existing trait
            await memoryService.reinforceMemory(existing[0].id, {
              confidence: Math.min(trait.confidence, 0.99),
            });
            continue;
          }
        } catch {}

        try {
          await memoryService.storeMemory({
            project: 'general',
            category: 'personality_trait',
            content: `Personality trait: ${trait.text}`,
            summary: trait.text,
            files: [],
            metadata: {
              trait_category: trait.category,
              confidence: trait.confidence,
              source: 'personality_extractor',
              extracted_at: new Date().toISOString(),
            },
          });
          storedCount++;
        } catch (err) {
          runtime.logger.warn(`[personality] Failed to store trait: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (storedCount > 0) {
        runtime.logger.info(`[personality] Extracted ${storedCount} personality trait(s)`);
      }
    } catch (error) {
      runtime.logger.error('Personality extractor error:', error instanceof Error ? error.message : String(error));
    }
  },
};
