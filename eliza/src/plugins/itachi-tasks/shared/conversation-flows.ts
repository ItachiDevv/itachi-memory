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

/** One active flow per chat. Key: `${chatId}` (single-user bot group) */
export const conversationFlows = new Map<string, ConversationFlow>();

/** Build the flow map key — uses chatId only since bot groups are typically single-user */
export function flowKey(chatId: number, _userId?: number): string {
  return `${chatId}`;
}

/** Get the active flow for a chat */
export function getFlow(chatId: number, _userId?: number): ConversationFlow | undefined {
  return conversationFlows.get(flowKey(chatId));
}

/** Set/replace the active flow for a chat. Resets TTL on each call. */
export function setFlow(chatId: number, _userId: number | undefined, flow: ConversationFlow): void {
  (flow as any).lastActivity = Date.now();
  conversationFlows.set(flowKey(chatId), flow);
}

/** Clear the active flow for a chat */
export function clearFlow(chatId: number, _userId?: number): void {
  conversationFlows.delete(flowKey(chatId));
}

// ── TTL Cleanup ──────────────────────────────────────────────────────
const FLOW_TTL_MS = 10 * 60 * 1000; // 10 minutes from last activity

export function cleanupStaleFlows(): void {
  const now = Date.now();
  for (const [key, flow] of conversationFlows) {
    // Use lastActivity if available (updated on each step), fall back to createdAt
    const lastActive = (flow as any).lastActivity || flow.createdAt;
    if (now - lastActive > FLOW_TTL_MS) {
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
//                sf:s:i.ds|i.cds|c.ds|c.cds|g.ds|g.cds — engine + mode

export function encodeCallback(prefix: string, key: string, value: string | number): string {
  return `${prefix}:${key}:${value}`;
}

export function decodeCallback(data: string): { prefix: string; key: string; value: string } | null {
  const parts = data.split(':');
  if (parts.length < 3) return null;
  return { prefix: parts[0], key: parts[1], value: parts.slice(2).join(':') };
}
