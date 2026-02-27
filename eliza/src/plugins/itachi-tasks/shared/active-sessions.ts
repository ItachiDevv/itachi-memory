import type { InteractiveSession } from '../services/ssh-service.js';
import type { TranscriptEntry } from '../utils/transcript-analyzer.js';

/** Session output mode */
export type SessionMode = 'stream-json' | 'tui';

export interface ActiveSession {
  sessionId: string;
  topicId: number;
  target: string;
  handle: InteractiveSession;
  startedAt: number;
  transcript: TranscriptEntry[];
  project: string;
  /** Output mode for this session */
  mode: SessionMode;
  /** Set when this session was spawned by TaskExecutorService */
  taskId?: string;
  /** Workspace path on remote machine (for executor sessions) */
  workspace?: string;
  /** Current engine running this session (claude, codex, gemini) */
  currentEngine?: string;
  /** Count of rate_limit_event messages received during this session */
  rateLimitCount?: number;
  /** Total assistant turns in this session */
  totalTurns?: number;
  /** Timestamp of last usage check */
  lastUsageCheckTime?: number;
}

/**
 * Global map of active sessions, keyed by Telegram topicId for fast lookup.
 * Shared between interactive-session action and TaskExecutorService.
 * The topic-input-relay evaluator checks this to pipe Telegram replies to SSH stdin.
 */
export const activeSessions = new Map<number, ActiveSession>();

/** Pending AskUserQuestion prompts waiting for Telegram callback. Key: topicId */
export const pendingQuestions = new Map<number, {
  toolId: string;
  options: string[];
}>();

/**
 * Topics currently spawning a session (browsing→session transition).
 * Prevents messages from leaking to TOPIC_REPLY or the LLM during the async
 * SSH connect + topic creation window where the threadId is in neither
 * browsingSessionMap nor activeSessions.
 */
export const spawningTopics = new Set<number>();

/**
 * Recently closed sessions — used by chatter suppression to block delayed LLM
 * responses that arrive after the session has already been removed from activeSessions.
 * Entries auto-expire after 30 seconds.
 */
export const recentlyClosedSessions = new Map<number, number>(); // topicId → closedAt timestamp

const RECENTLY_CLOSED_TTL_MS = 30_000;

/** Mark a session as recently closed (for chatter suppression). */
export function markSessionClosed(topicId: number): void {
  recentlyClosedSessions.set(topicId, Date.now());
  // Prune old entries
  for (const [id, closedAt] of recentlyClosedSessions) {
    if (Date.now() - closedAt > RECENTLY_CLOSED_TTL_MS) {
      recentlyClosedSessions.delete(id);
    }
  }
}

/** Check if a topic has an active, spawning, or recently-closed session. */
export function isSessionTopic(topicId: number): boolean {
  if (activeSessions.has(topicId)) return true;
  if (spawningTopics.has(topicId)) return true;
  const closedAt = recentlyClosedSessions.get(topicId);
  if (closedAt && Date.now() - closedAt < RECENTLY_CLOSED_TTL_MS) return true;
  if (closedAt) recentlyClosedSessions.delete(topicId);
  return false;
}
