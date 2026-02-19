import { type Plugin, type IAgentRuntime, ModelType, logger } from '@elizaos/core';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';

/**
 * Itachi Gemini Plugin — routes model calls to Gemini.
 *
 * TEXT_SMALL + OBJECT_SMALL: Routed to Gemini Flash when GEMINI_API_KEY is set.
 * TEXT_LARGE: Only routed to Gemini Pro when USE_GEMINI_LARGE=true.
 *
 * IMPORTANT: ElizaOS does NOT catch errors from model handlers — a throw crashes
 * the entire request with no fallback to lower-priority providers. This plugin uses
 * a getter on `models` that returns an empty map when disabled, so handlers are
 * never registered and Anthropic (priority 0) handles everything.
 */

// Module-level flags set during init — controls whether handlers are active
let geminiEnabled = false;
let geminiLargeEnabled = false;

function getApiKey(runtime: IAgentRuntime): string {
  return String(runtime.getSetting('GEMINI_API_KEY') ?? process.env.GEMINI_API_KEY ?? '');
}

function getSmallModel(runtime: IAgentRuntime): string {
  return String(runtime.getSetting('GEMINI_SMALL_MODEL') ?? process.env.GEMINI_SMALL_MODEL ?? 'gemini-3-flash-preview');
}

function getLargeModel(runtime: IAgentRuntime): string {
  return String(runtime.getSetting('GEMINI_LARGE_MODEL') ?? process.env.GEMINI_LARGE_MODEL ?? 'gemini-2.5-pro');
}

function isLargeEnabled(runtime: IAgentRuntime): boolean {
  const fromRuntime = runtime.getSetting('USE_GEMINI_LARGE');
  const fromEnv = process.env.USE_GEMINI_LARGE;
  const val = fromRuntime || fromEnv || 'false';
  logger.info(`[Gemini] USE_GEMINI_LARGE check — runtime: '${fromRuntime}', env: '${fromEnv}', resolved: '${val}'`);
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
      logger.warn('[Gemini] GEMINI_API_KEY not set — Gemini plugin disabled, Anthropic handles all models');
      geminiEnabled = false;
      return;
    }

    // Quick validation: try creating a client to ensure key format is valid
    try {
      createGeminiClient(runtime);
      geminiEnabled = true;
    } catch (err) {
      logger.error('[Gemini] Failed to create client — plugin disabled:', err instanceof Error ? err.message : String(err));
      geminiEnabled = false;
      geminiLargeEnabled = false;
      return;
    }

    geminiLargeEnabled = isLargeEnabled(runtime);
    logger.info(
      `[Gemini] Plugin active - TEXT_SMALL -> ${getSmallModel(runtime)}; TEXT_LARGE routed to Gemini: ${geminiLargeEnabled ? 'yes' : 'no'}`
    );
  },

  // Models are always registered, but handlers check geminiEnabled flag.
  // When disabled, they throw immediately — but since Gemini has priority 10,
  // we need to NOT register when disabled so Anthropic (priority 0) handles it.
  //
  // Solution: Register handlers that are no-ops when disabled.
  // Since ElizaOS doesn't support conditional registration, we use a getter pattern.
  get models() {
    // This getter is evaluated AFTER init() runs (ElizaOS calls init first, then reads models).
    // If Gemini is disabled (no API key), return empty → Anthropic handles everything.
    if (!geminiEnabled) {
      return {};
    }

    const handlers: Record<string, (runtime: IAgentRuntime, params: Record<string, unknown>) => Promise<unknown>> = {
      [ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params: Record<string, unknown>) => {
        try {
          return await handleTextSmall(runtime, params as Parameters<typeof handleTextSmall>[1]);
        } catch (err) {
          logger.error(`[Gemini] TEXT_SMALL error: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      },
      [ModelType.OBJECT_SMALL]: async (runtime: IAgentRuntime, params: Record<string, unknown>) => {
        try {
          return await handleObjectSmall(runtime, params as Parameters<typeof handleObjectSmall>[1]);
        } catch (err) {
          logger.error(`[Gemini] OBJECT_SMALL error: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      },
    };

    // Only register TEXT_LARGE handler when toggle is ON.
    // If not registered, Anthropic (priority 0) handles conversation — no crash.
    if (geminiLargeEnabled) {
      handlers[ModelType.TEXT_LARGE] = async (runtime: IAgentRuntime, params: Record<string, unknown>) => {
        try {
          return await handleTextLarge(runtime, params as Parameters<typeof handleTextLarge>[1]);
        } catch (err) {
          logger.error(`[Gemini] TEXT_LARGE error: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      };
    }

    return handlers;
  },
};
