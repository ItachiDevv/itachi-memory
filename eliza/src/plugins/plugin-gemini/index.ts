import { type Plugin, type IAgentRuntime, ModelType, logger } from '@elizaos/core';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';

/**
 * Itachi Gemini Plugin — routes model calls to Gemini.
 *
 * TEXT_SMALL + OBJECT_SMALL: Always routed to Gemini Flash (priority 10 > Anthropic 0).
 * TEXT_LARGE: Only routed to Gemini Pro when USE_GEMINI_LARGE=true (env var toggle).
 *             Default: off (Anthropic Sonnet handles conversation).
 *
 * Fallback: If GEMINI_API_KEY is missing, all handlers throw → ElizaOS falls back to Anthropic.
 */

function getApiKey(runtime: IAgentRuntime): string {
  return runtime.getSetting('GEMINI_API_KEY') ?? process.env.GEMINI_API_KEY ?? '';
}

function getSmallModel(runtime: IAgentRuntime): string {
  return runtime.getSetting('GEMINI_SMALL_MODEL') ?? process.env.GEMINI_SMALL_MODEL ?? 'gemini-2.5-flash';
}

function getLargeModel(runtime: IAgentRuntime): string {
  return runtime.getSetting('GEMINI_LARGE_MODEL') ?? process.env.GEMINI_LARGE_MODEL ?? 'gemini-2.5-pro';
}

function isLargeEnabled(runtime: IAgentRuntime): boolean {
  const val = runtime.getSetting('USE_GEMINI_LARGE') ?? process.env.USE_GEMINI_LARGE ?? 'false';
  return val === 'true' || val === '1';
}

function createGeminiClient(runtime: IAgentRuntime) {
  return createGoogleGenerativeAI({
    apiKey: getApiKey(runtime),
  });
}

/** Shared providerOptions to disable thinking (saves tokens for structured extraction) */
const noThinking = {
  google: { thinkingConfig: { thinkingBudget: 0 } },
};

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
  logger.log(`[Gemini] TEXT_SMALL → ${modelName}`);

  const { text } = await generateText({
    model: google(modelName),
    prompt,
    temperature,
    maxOutputTokens: maxTokens,
    stopSequences,
    providerOptions: noThinking,
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
  logger.log(`[Gemini] OBJECT_SMALL → ${modelName}`);

  const { text } = await generateText({
    model: google(modelName),
    prompt,
    temperature,
    maxOutputTokens: maxTokens,
    providerOptions: noThinking,
  });

  return text;
}

async function handleTextLarge(
  runtime: IAgentRuntime,
  {
    prompt,
    stopSequences = [],
    maxTokens = 16384,
    temperature = 0.7,
  }: {
    prompt: string;
    stopSequences?: string[];
    maxTokens?: number;
    temperature?: number;
  }
): Promise<string> {
  const google = createGeminiClient(runtime);
  const modelName = getLargeModel(runtime);
  logger.log(`[Gemini] TEXT_LARGE → ${modelName}`);

  const { text } = await generateText({
    model: google(modelName),
    prompt,
    temperature,
    maxOutputTokens: maxTokens,
    stopSequences,
    // Allow thinking for conversation (Pro) but cap it to not consume all output tokens
    providerOptions: {
      google: { thinkingConfig: { thinkingBudget: 4096 } },
    },
  });

  return text;
}

export const itachiGeminiPlugin: Plugin = {
  name: 'itachi-gemini',
  description: 'Routes TEXT_SMALL/OBJECT_SMALL to Gemini Flash, optionally TEXT_LARGE to Gemini Pro',
  priority: 10,

  config: {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_SMALL_MODEL: process.env.GEMINI_SMALL_MODEL,
    GEMINI_LARGE_MODEL: process.env.GEMINI_LARGE_MODEL,
    USE_GEMINI_LARGE: process.env.USE_GEMINI_LARGE,
  },

  async init(_config, runtime) {
    const apiKey = getApiKey(runtime);
    if (!apiKey) {
      logger.warn('[Gemini] GEMINI_API_KEY not set — Gemini plugin disabled, falling back to Anthropic');
      return;
    }
    const largeEnabled = isLargeEnabled(runtime);
    logger.info(`[Gemini] Plugin initialized — TEXT_SMALL → ${getSmallModel(runtime)}, TEXT_LARGE → ${largeEnabled ? getLargeModel(runtime) : 'Anthropic (toggle off)'}`);
  },

  models: {
    [ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params: Record<string, unknown>) => {
      const apiKey = getApiKey(runtime);
      if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
      return handleTextSmall(runtime, params as Parameters<typeof handleTextSmall>[1]);
    },
    [ModelType.OBJECT_SMALL]: async (runtime: IAgentRuntime, params: Record<string, unknown>) => {
      const apiKey = getApiKey(runtime);
      if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
      return handleObjectSmall(runtime, params as Parameters<typeof handleObjectSmall>[1]);
    },
    [ModelType.TEXT_LARGE]: async (runtime: IAgentRuntime, params: Record<string, unknown>) => {
      // Only intercept if toggle is enabled; otherwise throw to fall back to Anthropic
      if (!isLargeEnabled(runtime)) {
        throw new Error('USE_GEMINI_LARGE not enabled — falling back to Anthropic');
      }
      const apiKey = getApiKey(runtime);
      if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
      return handleTextLarge(runtime, params as Parameters<typeof handleTextLarge>[1]);
    },
  },
};
