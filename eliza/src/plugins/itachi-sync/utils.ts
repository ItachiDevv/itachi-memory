import type { IAgentRuntime } from '@elizaos/core';

// UUID v4 format
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate UUID format */
export function isValidUUID(str: string): boolean {
  return UUID_RE.test(str);
}

/** Safe parseInt with clamping. Returns defaultVal on NaN. */
export function clampLimit(value: string | undefined, defaultVal = 10, max = 100): number {
  const parsed = parseInt(value || '', 10);
  if (isNaN(parsed) || parsed < 1) return defaultVal;
  return Math.min(parsed, max);
}

/** Valid task status values */
const VALID_STATUSES = new Set([
  'queued', 'claimed', 'running', 'completed', 'failed', 'cancelled', 'timeout',
]);

/** Check if a task status value is valid */
export function isValidStatus(status: string): boolean {
  return VALID_STATUSES.has(status);
}

/** Sanitize error for client response — hide DB internals */
export function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message;
    // Hide Supabase/Postgres internals
    if (msg.includes('schema cache') || msg.includes('column') || msg.includes('relation')) {
      return 'Internal database error';
    }
    if (msg.includes('invalid input syntax')) {
      return 'Invalid input format';
    }
    return msg;
  }
  return 'Internal server error';
}

/**
 * Check API key auth. Returns true if authorized.
 * If ITACHI_API_KEY is not set, auth is skipped (backward compat).
 */
export function checkAuth(
  req: { headers: Record<string, string | string[] | undefined> },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  runtime: IAgentRuntime
): boolean {
  const apiKey = runtime.getSetting('ITACHI_API_KEY');
  if (!apiKey) return true; // no key configured = open access

  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '') : '';

  if (token !== apiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/** Max allowed field lengths for input validation */
export const MAX_LENGTHS = {
  summary: 1000,
  description: 5000,
  diff: 50000,
  project: 200,
  branch: 200,
  category: 100,
  file_path: 500,
  query: 2000,
  encrypted_data: 5_000_000, // 5MB
} as const;

/** Truncate a string to max length */
export function truncate(str: string | undefined, max: number): string {
  if (!str) return '';
  return str.length > max ? str.substring(0, max) : str;
}
