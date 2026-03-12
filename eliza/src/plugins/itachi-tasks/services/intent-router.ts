import type { IAgentRuntime } from '@elizaos/core';
import { ModelType } from '@elizaos/core';

export type Intent =
  | { type: 'conversation'; message: string }
  | { type: 'task'; description: string; project?: string; machine?: string }
  | { type: 'question'; query: string; project?: string }
  | { type: 'feedback'; sentiment: 'positive' | 'negative'; detail: string };

const CLASSIFY_PROMPT = `You are Itachi's intent classifier. Given a Telegram message from Itachisan, classify it.

Known projects: {{projects}}
Known machines: {{machines}}

Respond with EXACTLY one JSON object, no other text:

For casual conversation, greetings, sharing thoughts, personal topics:
{"type": "conversation", "message": "<the original message>"}

For requests to build, implement, fix, deploy, create, update, refactor code:
{"type": "task", "description": "<what to do>", "project": "<repo name if mentioned or inferrable, else null>", "machine": "<target machine if mentioned, else null>"}

For questions about code, architecture, how something works, past decisions:
{"type": "question", "query": "<the question>", "project": "<repo if mentioned, else null>"}

For feedback on Itachi's work, corrections, praise, complaints about quality:
{"type": "feedback", "sentiment": "<positive or negative>", "detail": "<what the feedback is about>"}

Message: {{message}}`;

export async function classifyIntent(
  runtime: IAgentRuntime,
  message: string,
  context: { projects: string[]; machines: string[] }
): Promise<Intent> {
  const prompt = CLASSIFY_PROMPT
    .replace('{{projects}}', context.projects.join(', ') || 'unknown')
    .replace('{{machines}}', context.machines.join(', ') || 'air, hood, surface, cool')
    .replace('{{message}}', message);

  try {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      temperature: 0.1,
      maxTokens: 200,
    });

    const text = typeof response === 'string' ? response : (response as any)?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { type: 'conversation', message };
    return JSON.parse(jsonMatch[0]) as Intent;
  } catch {
    return { type: 'conversation', message };
  }
}
