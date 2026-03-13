import { type Evaluator, type IAgentRuntime, type Memory, type State, ModelType } from '@elizaos/core';
import { MemoryService } from '../services/memory-service.js';
import { createClient } from '@supabase/supabase-js';

const TAG = '[CONVERSATION_MEMORY]';

/**
 * Unified conversation memory + classification + chat_history logger.
 *
 * Single LLM call per Telegram message:
 * 1. Classifies message type (task, question, conversation)
 * 2. Scores significance for long-term memory
 * 3. Extracts facts
 * 4. Logs to chat_history table
 * 5. If task → creates task via TaskService
 */
export const conversationMemoryEvaluator: Evaluator = {
  name: 'CONVERSATION_MEMORY',
  description: 'Classify messages, score significance, extract facts, log to chat_history, and create tasks — all in one LLM call',
  similes: ['remember conversation', 'store chat context', 'extract facts', 'classify message'],
  alwaysRun: true,

  examples: [
    {
      prompt: 'User asked about PostgreSQL migration decision and Itachi confirmed the approach.',
      messages: [
        { name: '{{name1}}', content: { text: 'Should we use PostgreSQL for the migration?' } },
        { name: 'Itachi', content: { text: 'Yes, PostgreSQL is the right choice given our data model.' } },
      ],
      outcome: 'Classified as "question", stored memory with significance 0.85, extracted 1 fact.',
    },
    {
      prompt: 'User asked Itachi to deploy the app.',
      messages: [
        { name: '{{name1}}', content: { text: 'deploy the app to production' } },
        { name: 'Itachi', content: { text: 'On it — creating task.' } },
      ],
      outcome: 'Classified as "task", created task, logged to chat_history.',
    },
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    // Only process Telegram messages
    const source = message.content?.source;
    if (source !== 'telegram') return false;

    // Skip bot's own messages
    if (message.entityId === message.agentId) return false;

    // Process all messages (even short ones for chat_history logging)
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ): Promise<void> => {
    try {
      const currentMessage = message.content?.text || '';
      if (!currentMessage.trim()) return;

      // Skip slash commands — those are handled by the interceptor
      if (currentMessage.startsWith('/')) return;

      const memoryService = runtime.getService<MemoryService>('itachi-memory');

      // Gather recent conversation context (includes bot's latest reply)
      const recentMessages = state?.data?.recentMessages || [];
      const recentArr = Array.isArray(recentMessages) ? recentMessages.slice(-6) : [];
      const context = recentArr
        .map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)
        .join('\n');

      // Extract bot's most recent response for chat_history
      const botResponse = recentArr
        .filter((m: { role: string }) => m.role === 'assistant' || m.role === 'Itachi')
        .pop()?.content || '';

      // Single LLM call: classification + significance + summary + facts
      const prompt = `You are analyzing a Telegram message sent to Itachi (an AI assistant/project manager).

Recent conversation (including bot's latest reply):
${context}

The most recent user message:
${currentMessage}

Do ALL of the following in a single response:

1. CLASSIFY the message type:
   - "task": The user wants an action performed or verified — install, build, fix, deploy, set up, create, check, update, delete, run, scrape, monitor, schedule, configure, test, etc. Includes polite requests ("can you..."), follow-ups ("did you install X?"), and verification requests ("is X working?"). When in doubt between task and question, lean toward task.
   - "question": The user is asking about concepts or information, NOT requesting action — "how does X work?", "what is a dockerfile?", "why do we use supabase?"
   - "conversation": Pure social interaction — greetings, thanks, jokes, opinions, venting, checking in, with no implicit request for action or information.

2. Score significance 0.0-1.0 for long-term memory:
   - 0.0-0.2: Greetings, thanks, acknowledgments, small talk
   - 0.3-0.5: General questions, status updates, minor clarifications
   - 0.6-0.8: Technical decisions, preferences expressed, important context shared
   - 0.9-1.0: Critical decisions, architectural choices, project pivots, explicit "remember this"

3. Extract concrete, reusable facts (if any):
   - Personal details (name, location, timezone, role, company)
   - Preferences (tools, languages, frameworks, workflows)
   - Project details (names, tech stack, architecture decisions)
   - Decisions made or plans stated
   Return empty array if no facts are present.

4. For each fact, classify as "identity" or "fact":
   - "identity": Core personal attributes, personality, communication style, deeply held preferences — WHO the user is
   - "fact": Project-specific details, technical decisions, temporary preferences — things that may change

5. Extract:
   - A 1-2 sentence summary of the exchange
   - The project name if mentioned (or "general" if none)

Respond ONLY with valid JSON, no markdown fences:
{"message_type": "task|question|conversation", "significance": 0.0, "summary": "...", "project": "...", "facts": [{"fact": "...", "project": "...", "tier": "identity|fact"}]}`;

      const result = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.2,
      });

      const raw = typeof result === 'string' ? result : String(result);
      let parsed: {
        message_type: string;
        significance: number;
        summary: string;
        project: string;
        facts?: Array<{ fact: string; project?: string; tier?: string }>;
      };
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        runtime.logger.warn(`${TAG} unparseable LLM output: ${raw.substring(0, 100)}`);
        return;
      }

      if (!parsed.message_type || typeof parsed.significance !== 'number' || !parsed.summary) return;

      const messageType = ['task', 'question', 'conversation'].includes(parsed.message_type)
        ? parsed.message_type
        : 'conversation';
      const significance = Math.max(0, Math.min(1, parsed.significance));
      const project = parsed.project || 'general';

      runtime.logger.info(
        `${TAG} classified: "${currentMessage.substring(0, 50)}" → ${messageType} (sig=${significance.toFixed(2)}, project=${project})`
      );

      // --- 1. Log to chat_history ---
      await logToChatHistory(runtime, {
        userId: Number(runtime.getSetting('ITACHI_ALLOWED_USERS')?.toString().split(',')[0] || '0'),
        prompt: currentMessage,
        response: botResponse,
        messageType,
        project,
        significance,
        summary: parsed.summary,
        model: 'gemini', // ElizaOS default
      });

      // --- 2. If task → create task via TaskService ---
      if (messageType === 'task') {
        try {
          const { TaskService } = await import('../../itachi-tasks/services/task-service.js');
          const taskService = runtime.getService<InstanceType<typeof TaskService>>('itachi-tasks');
          if (taskService) {
            const chatId = Number(runtime.getSetting('TELEGRAM_GROUP_CHAT_ID') || '0');
            const userId = Number(runtime.getSetting('ITACHI_ALLOWED_USERS')?.toString().split(',')[0] || '0');
            const newTask = await taskService.createTask({
              description: currentMessage,
              project: 'auto',
              telegram_chat_id: chatId,
              telegram_user_id: userId,
            });
            runtime.logger.info(`${TAG} created task ${newTask.id.substring(0, 8)} from message: "${currentMessage.substring(0, 60)}"`);
          }
        } catch (err) {
          runtime.logger.error(`${TAG} task creation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // --- 3. Store conversation memory (for significant messages) ---
      if (memoryService && significance >= 0.2) {
        await memoryService.storeMemory({
          project,
          category: 'conversation',
          content: currentMessage,
          summary: parsed.summary,
          files: [],
          metadata: { significance, source: 'telegram', message_type: messageType },
        });
      }

      // --- 4. Store extracted facts ---
      let factsStored = 0;
      let identityStored = 0;
      if (memoryService && Array.isArray(parsed.facts) && significance >= 0.3) {
        for (const item of parsed.facts) {
          if (!item.fact || item.fact.length < 5) continue;
          const tier = item.tier === 'identity' || significance >= 0.9 ? 'identity' : 'fact';
          const stored = await memoryService.storeFact(item.fact, item.project || project, tier);
          if (stored) {
            if (tier === 'identity') identityStored++;
            else factsStored++;
          }
        }
      }

      runtime.logger.info(
        `${TAG} stored (type=${messageType}, sig=${significance.toFixed(2)}, project=${project}, facts=${factsStored}, identity=${identityStored})`
      );
    } catch (error) {
      runtime.logger.error(`${TAG} error:`, error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Insert a row into the chat_history table.
 */
async function logToChatHistory(
  runtime: IAgentRuntime,
  params: {
    userId: number;
    prompt: string;
    response: string;
    messageType: string;
    project: string;
    significance: number;
    summary: string;
    model: string;
  },
): Promise<void> {
  try {
    const url = String(runtime.getSetting('SUPABASE_URL') || '');
    const key = String(runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY') || runtime.getSetting('SUPABASE_KEY') || '');
    if (!url || !key) return;

    const supabase = createClient(url, key);
    const { error } = await supabase.from('chat_history').insert({
      session_id: `tg-${Date.now()}`,
      user_id: params.userId,
      prompt: params.prompt,
      response: params.response || null,
      message_type: params.messageType,
      model: params.model,
      metadata: {
        project: params.project,
        significance: params.significance,
        summary: params.summary,
      },
    });

    if (error) {
      runtime.logger.warn(`${TAG} chat_history insert failed: ${error.message}`);
    }
  } catch (err) {
    runtime.logger.warn(`${TAG} chat_history logging error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
