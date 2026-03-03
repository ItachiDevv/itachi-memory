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

// ── globalThis-backed topic ID sets ─────────────────────────────────
// ESM/CJS dual-loading can create separate module caches, causing
// different parts of the codebase to see different Map instances.
// These globalThis Sets mirror the keys so cross-module checks
// (like the chatter-patch in callback-handler.ts) always work.
const _gkActive = '__itachi_activeTopicIds';
if (!(globalThis as any)[_gkActive]) (globalThis as any)[_gkActive] = new Set<number>();
const _activeTopicIds: Set<number> = (globalThis as any)[_gkActive];

const _gkSpawning = '__itachi_spawningTopicIds';
if (!(globalThis as any)[_gkSpawning]) (globalThis as any)[_gkSpawning] = new Set<number>();
const _spawningTopicIds: Set<number> = (globalThis as any)[_gkSpawning];

const _gkClosed = '__itachi_closedTopicIds';
if (!(globalThis as any)[_gkClosed]) (globalThis as any)[_gkClosed] = new Set<number>();
const _closedTopicIds: Set<number> = (globalThis as any)[_gkClosed];

/**
 * Global map of active sessions, keyed by Telegram topicId for fast lookup.
 * Shared between interactive-session action and TaskExecutorService.
 * The topic-input-relay evaluator checks this to pipe Telegram replies to SSH stdin.
 *
 * Subclassed to auto-maintain a globalThis-backed Set of topic IDs
 * so cross-module checks (chatter patch) survive ESM/CJS dual-loading.
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
export const activeSessions: Map<number, ActiveSession> = new TrackedSessionMap();

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
 *
 * Entries auto-expire after SPAWNING_TIMEOUT_MS as a safety net in case
 * spawnSessionInTopic hangs (SSH connect stall, etc.).
 */
const _spawningTopicsMap = new Map<number, number>(); // topicId → addedAt timestamp
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
export const recentlyClosedSessions = new Map<number, number>(); // topicId → closedAt timestamp

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
export const closedSessionMeta = new Map<number, ClosedSessionMeta>();

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
 * Suppress next LLM-generated message to a specific threadId (General topic = 1).
 * Used when /session commands are processed — the handler sends its own callback text,
 * but the LLM also generates a duplicate response that needs suppression.
 * Entries auto-expire after 15 seconds as a safety net.
 */
// Use globalThis to guarantee the Map is shared across module instances.
// ESM/CJS dual-loading can create separate module caches, causing
// suppressNextLLMMessage and shouldSuppressLLMMessage to use different Maps.
const _globalKey = '__itachi_suppressLLMMap';
if (!(globalThis as any)[_globalKey]) {
  (globalThis as any)[_globalKey] = new Map<string, number>();
}
const _suppressLLMMap: Map<string, number> = (globalThis as any)[_globalKey];
const SUPPRESS_TTL_MS = 180_000; // 180s — LLM generation can take 60-120s under load

/** Mark that the next LLM-generated sendMessage to this chat/thread should be suppressed. */
export function suppressNextLLMMessage(chatId: number, threadId?: number | null): void {
  const key = `${chatId}:${threadId ?? 'main'}`;
  _suppressLLMMap.set(key, Date.now());
}

/** Check (and consume) if the next sendMessage to this chat/thread should be suppressed. */
export function shouldSuppressLLMMessage(chatId: number, threadId?: number | null): boolean {
  const key = `${chatId}:${threadId ?? 'main'}`;
  const ts = _suppressLLMMap.get(key);
  if (ts === undefined) return false;
  _suppressLLMMap.delete(key);
  if (Date.now() - ts > SUPPRESS_TTL_MS) return false;
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
