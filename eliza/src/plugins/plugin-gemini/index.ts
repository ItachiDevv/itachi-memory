import { type Plugin, type IAgentRuntime, ModelType, logger } from '@elizaos/core';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';

/**
 * Itachi Gemini Plugin — routes TEXT_SMALL and OBJECT_SMALL to Gemini Flash.
 *
 * Registers with priority 10 so it takes precedence over plugin-anthropic (priority 0)
 * for small-model calls. TEXT_LARGE stays on Anthropic for conversation quality.
 *
 * This saves ~5-7x on background worker costs (evaluators, synthesizers, analyzers)
 * while keeping the Telegram personality on Claude Sonnet.
 */

function getApiKey(runtime: IAgentRuntime): string {
  return runtime.getSetting('GEMINI_API_KEY') ?? process.env.GEMINI_API_KEY ?? '';
}

function getSmallModel(runtime: IAgentRuntime): string {
  return runtime.getSetting('GEMINI_SMALL_MODEL') ?? process.env.GEMINI_SMALL_MODEL ?? 'gemini-2.5-flash-preview-05-20';
}

function createGeminiClient(runtime: IAgentRuntime) {
  return createGoogleGenerativeAI({
    apiKey: getApiKey(runtime),
  });
}

async function handleTextSmall(
  runtime: IAgentRuntime,
  {
    prompt,
    stopSequences = [],
    maxTokens = 8192,
    temperature = 0.7,
  }: {
    prompt: string;
    stopSequences?: string[];
    maxTokens?: number;
    temperature?: number;
  }
): Promise<string> {
  const google = createGeminiClient(runtime);
  const modelName = getSmallModel(runtime);
  logger.log(`[Gemini] Using TEXT_SMALL model: ${modelName}`);

  const { text } = await generateText({
    model: google(modelName),
    prompt,
    temperature,
    maxOutputTokens: maxTokens,
    stopSequences,
  });

  return text;
}

async function handleObjectSmall(
  runtime: IAgentRuntime,
  {
    prompt,
    maxTokens = 8192,
    temperature = 0.7,
  }: {
    prompt: string;
    maxTokens?: number;
    temperature?: number;
  }
): Promise<string> {
  const google = createGeminiClient(runtime);
  const modelName = getSmallModel(runtime);
  logger.log(`[Gemini] Using OBJECT_SMALL model: ${modelName}`);

  const { text } = await generateText({
    model: google(modelName),
    prompt,
    temperature,
    maxOutputTokens: maxTokens,
  });

  return text;
}

export const itachiGeminiPlugin: Plugin = {
  name: 'itachi-gemini',
  description: 'Routes TEXT_SMALL/OBJECT_SMALL to Gemini Flash for cost-efficient background processing',
  priority: 10, // Higher than Anthropic (0) — wins for TEXT_SMALL routing

  config: {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_SMALL_MODEL: process.env.GEMINI_SMALL_MODEL,
  },

  async init(_config, runtime) {
    const apiKey = getApiKey(runtime);
    if (!apiKey) {
      logger.warn('[Gemini] GEMINI_API_KEY not set — Gemini plugin disabled, falling back to Anthropic');
      return;
    }
    logger.info(`[Gemini] Plugin initialized — TEXT_SMALL routed to ${getSmallModel(runtime)}`);
  },

  models: {
    [ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params: Record<string, unknown>) => {
      const apiKey = getApiKey(runtime);
      if (!apiKey) {
        // Fallback: let next handler (Anthropic) handle it
        throw new Error('GEMINI_API_KEY not configured');
      }
      return handleTextSmall(runtime, params as Parameters<typeof handleTextSmall>[1]);
    },
    [ModelType.OBJECT_SMALL]: async (runtime: IAgentRuntime, params: Record<string, unknown>) => {
      const apiKey = getApiKey(runtime);
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY not configured');
      }
      return handleObjectSmall(runtime, params as Parameters<typeof handleObjectSmall>[1]);
    },
  },
};
