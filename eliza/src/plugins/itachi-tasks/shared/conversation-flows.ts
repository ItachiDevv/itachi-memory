/**
 * Conversation state machine for multi-step inline-button flows.
 * Supports /task and /session interactive flows via Telegram inline keyboards.
 */

export type FlowType = 'task' | 'session';

export type TaskFlowStep =
  | 'select_machine'
  | 'select_repo_mode'
  | 'select_repo'
  | 'await_description';

export type SessionFlowStep =
  | 'select_machine'
  | 'select_repo'
  | 'select_subfolder'
  | 'select_start_mode';

export type FlowStep = TaskFlowStep | SessionFlowStep;

export interface ConversationFlow {
  flowType: FlowType;
  step: FlowStep;
  chatId: number;
  userId: number;
  messageId: number; // message with inline keyboard to edit
  createdAt: number;

  // Accumulated selections
  machine?: string;        // SSH target name
  repoMode?: 'new' | 'existing';
  repoPath?: string;       // Full path to repo
  project?: string;        // Project name (repo folder name)
  taskName?: string;       // For task flows only
  engineCommand?: string;  // Resolved CLI wrapper

  // Cached data for keyboards
  cachedMachines?: Array<{ id: string; name: string; status: string }>;
  cachedDirs?: string[];
}

/** One active flow per user per chat. Key: `${chatId}:${userId}` */
export const conversationFlows = new Map<string, ConversationFlow>();

/** Build the flow map key */
export function flowKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

/** Get a user's active flow */
export function getFlow(chatId: number, userId: number): ConversationFlow | undefined {
  return conversationFlows.get(flowKey(chatId, userId));
}

/** Set/replace a user's active flow */
export function setFlow(chatId: number, userId: number, flow: ConversationFlow): void {
  conversationFlows.set(flowKey(chatId, userId), flow);
}

/** Clear a user's active flow */
export function clearFlow(chatId: number, userId: number): void {
  conversationFlows.delete(flowKey(chatId, userId));
}

// ── TTL Cleanup ──────────────────────────────────────────────────────
const FLOW_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function cleanupStaleFlows(): void {
  const now = Date.now();
  for (const [key, flow] of conversationFlows) {
    if (now - flow.createdAt > FLOW_TTL_MS) {
      conversationFlows.delete(key);
    }
  }
}

// ── Callback data encoding ──────────────────────────────────────────
// Telegram callback_data is limited to 64 bytes. Keep it short.
//
// Task flow:     tf:m:<idx>           — machine selection
//                tf:rm:new|existing   — repo mode
//                tf:r:<idx>           — repo selection
//
// Session flow:  sf:m:<idx>           — machine selection
//                sf:r:<idx>           — repo/folder selection
//                sf:d:<idx>|here      — subfolder or "start here"
//                sf:s:ds|cds          — start mode (fresh / continue)

export function encodeCallback(prefix: string, key: string, value: string | number): string {
  return `${prefix}:${key}:${value}`;
}

export function decodeCallback(data: string): { prefix: string; key: string; value: string } | null {
  const parts = data.split(':');
  if (parts.length < 3) return null;
  return { prefix: parts[0], key: parts[1], value: parts.slice(2).join(':') };
}
