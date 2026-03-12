import type { InteractiveSession } from '../services/ssh-service.js';
import type { TranscriptEntry } from '../utils/transcript-analyzer.js';
// SessionDriver removed — TODO: revisit after orchestrator migration
// Inline the minimal interface needed by ActiveSession
interface SessionDriverLike {
  onHumanInput(text: string): void;
  onChunk(chunk: any): void;
  onTurnComplete(): Promise<void>;
  isDone(): boolean;
  sendCompletionSummary(status: string, files: string[], prUrl?: string): Promise<void>;
}

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
  /** SessionDriver for multi-turn executor sessions */
  driver?: SessionDriverLike;
}

// ── globalThis-backed shared state ───────────────────────────────────
// ESM/CJS dual-loading can create separate module caches, causing
// different parts of the codebase to see different Map instances.
// ALL shared Maps/Sets live on globalThis so every module copy sees
// the same data. This is critical for the relay→suppress→patch chain.

function gGet<T>(key: string, factory: () => T): T {
  if (!(globalThis as any)[key]) (globalThis as any)[key] = factory();
  return (globalThis as any)[key] as T;
}

const _activeTopicIds = gGet('__itachi_activeTopicIds', () => new Set<number>());
const _spawningTopicIds = gGet('__itachi_spawningTopicIds', () => new Set<number>());
const _closedTopicIds = gGet('__itachi_closedTopicIds', () => new Set<number>());

/**
 * Global map of active sessions, keyed by Telegram topicId for fast lookup.
 * Shared between interactive-session action and TaskExecutorService.
 * The topic-input-relay evaluator checks this to pipe Telegram replies to SSH stdin.
 *
 * Lives on globalThis so ALL module instances (ESM+CJS) share the same Map.
 * TrackedSessionMap auto-maintains a globalThis Set of topic IDs as well.
 */
class TrackedSessionMap extends Map<number, ActiveSession> {
  override set(key: number, value: ActiveSession): this {
    _activeTopicIds.add(key);
    return super.set(key, value);
  }
  override delete(key: number): boolean {
    _activeTopicIds.delete(key);
    return super.delete(key);
  }
  override clear(): void {
    for (const key of this.keys()) _activeTopicIds.delete(key);
    super.clear();
  }
}

// The Map itself lives on globalThis — not just the topic ID set.
// This ensures relay's activeSessions.get(topicId) finds sessions
// added by interactive-session.ts even under ESM/CJS dual-loading.
export const activeSessions: Map<number, ActiveSession> = gGet(
  '__itachi_activeSessions',
  () => new TrackedSessionMap(),
);

/** Pending AskUserQuestion prompts waiting for Telegram callback. Key: topicId */
export const pendingQuestions = gGet(
  '__itachi_pendingQuestions',
  () => new Map<number, { toolId: string; options: string[] }>(),
);

/**
 * Topics currently spawning a session (browsing→session transition).
 * Prevents messages from leaking to TOPIC_REPLY or the LLM during the async
 * SSH connect + topic creation window where the threadId is in neither
 * browsingSessionMap nor activeSessions.
 *
 * Entries auto-expire after SPAWNING_TIMEOUT_MS as a safety net in case
 * spawnSessionInTopic hangs (SSH connect stall, etc.).
 */
const _spawningTopicsMap = gGet('__itachi_spawningTopicsMap', () => new Map<number, number>());
const SPAWNING_TIMEOUT_MS = 60_000; // 60 seconds max

/** Proxy Set that auto-expires entries after SPAWNING_TIMEOUT_MS */
export const spawningTopics = {
  add(topicId: number): void {
    _spawningTopicsMap.set(topicId, Date.now());
    _spawningTopicIds.add(topicId);
  },
  delete(topicId: number): boolean {
    _spawningTopicIds.delete(topicId);
    return _spawningTopicsMap.delete(topicId);
  },
  has(topicId: number): boolean {
    const addedAt = _spawningTopicsMap.get(topicId);
    if (addedAt === undefined) {
      // Cross-module fallback: globalThis set may have it
      return _spawningTopicIds.has(topicId);
    }
    if (Date.now() - addedAt > SPAWNING_TIMEOUT_MS) {
      _spawningTopicsMap.delete(topicId);
      _spawningTopicIds.delete(topicId);
      return false;
    }
    return true;
  },
  get size(): number {
    // Prune expired during size check
    for (const [id, addedAt] of _spawningTopicsMap) {
      if (Date.now() - addedAt > SPAWNING_TIMEOUT_MS) {
        _spawningTopicsMap.delete(id);
        _spawningTopicIds.delete(id);
      }
    }
    return _spawningTopicsMap.size;
  },
};

/**
 * Recently closed sessions — used by chatter suppression to block delayed LLM
 * responses that arrive after the session has already been removed from activeSessions.
 * Entries auto-expire after 30 seconds.
 */
export const recentlyClosedSessions = gGet('__itachi_recentlyClosedSessions', () => new Map<number, number>());

const RECENTLY_CLOSED_TTL_MS = 30_000;

/**
 * Metadata from closed sessions — used to respawn sessions when users send
 * follow-up messages in session topics after the session has exited.
 * Entries auto-expire after 1 hour.
 */
export interface ClosedSessionMeta {
  target: string;
  project: string;
  engineCommand: string;
  repoPath: string;
  mode: SessionMode;
  closedAt: number;
}

const CLOSED_META_TTL_MS = 3_600_000; // 1 hour
export const closedSessionMeta = gGet('__itachi_closedSessionMeta', () => new Map<number, ClosedSessionMeta>());

/** Mark a session as recently closed (for chatter suppression + respawn metadata). */
export function markSessionClosed(topicId: number, meta?: Omit<ClosedSessionMeta, 'closedAt'>): void {
  recentlyClosedSessions.set(topicId, Date.now());
  _closedTopicIds.add(topicId);
  if (meta) {
    closedSessionMeta.set(topicId, { ...meta, closedAt: Date.now() });
  }
  // Prune old entries
  for (const [id, closedAt] of recentlyClosedSessions) {
    if (Date.now() - closedAt > RECENTLY_CLOSED_TTL_MS) {
      recentlyClosedSessions.delete(id);
      _closedTopicIds.delete(id);
    }
  }
  for (const [id, m] of closedSessionMeta) {
    if (Date.now() - m.closedAt > CLOSED_META_TTL_MS) {
      closedSessionMeta.delete(id);
    }
  }
}

/** Get closed session metadata for respawning. Returns null if expired or not found. */
export function getClosedSessionMeta(topicId: number): ClosedSessionMeta | null {
  const meta = closedSessionMeta.get(topicId);
  if (!meta) return null;
  if (Date.now() - meta.closedAt > CLOSED_META_TTL_MS) {
    closedSessionMeta.delete(topicId);
    return null;
  }
  return meta;
}

/**
 * Suppress LLM-generated messages to a specific chat/thread.
 * Set by topic-input-relay when piping messages to SSH sessions — prevents
 * ElizaOS from also generating an LLM personality response for the same input.
 * Non-consuming: blocks ALL sendMessage calls within the TTL window.
 */
const _suppressLLMMap = gGet('__itachi_suppressLLMMap', () => new Map<string, number>());
const SUPPRESS_TTL_MS = 180_000; // 180s — LLM generation can take 60-120s under load

/** Mark that the next LLM-generated sendMessage to this chat/thread should be suppressed. */
export function suppressNextLLMMessage(chatId: number, threadId?: number | null): void {
  const key = `${chatId}:${threadId ?? 'main'}`;
  _suppressLLMMap.set(key, Date.now());
}

/** Check if sendMessage to this chat/thread should be suppressed.
 *  Non-consuming: blocks ALL sendMessage calls within the TTL window,
 *  not just the first one. ElizaOS can make multiple LLM calls per
 *  user message, and each can generate a separate sendMessage call. */
export function shouldSuppressLLMMessage(chatId: number, threadId?: number | null): boolean {
  const key = `${chatId}:${threadId ?? 'main'}`;
  const ts = _suppressLLMMap.get(key);
  if (ts === undefined) return false;
  if (Date.now() - ts > SUPPRESS_TTL_MS) {
    _suppressLLMMap.delete(key);
    return false;
  }
  return true;
}

/** Check if a topic has an active, spawning, or recently-closed session.
 *  Uses globalThis-backed Sets as fallback for cross-module visibility
 *  (ESM/CJS dual-loading can cause different module instances). */
export function isSessionTopic(topicId: number): boolean {
  if (activeSessions.has(topicId)) return true;
  if (_activeTopicIds.has(topicId)) return true;   // globalThis fallback
  if (spawningTopics.has(topicId)) return true;
  if (_spawningTopicIds.has(topicId)) return true;  // globalThis fallback
  const closedAt = recentlyClosedSessions.get(topicId);
  if (closedAt && Date.now() - closedAt < RECENTLY_CLOSED_TTL_MS) return true;
  if (_closedTopicIds.has(topicId)) return true;    // globalThis fallback
  if (closedAt) recentlyClosedSessions.delete(topicId);
  return false;
}
