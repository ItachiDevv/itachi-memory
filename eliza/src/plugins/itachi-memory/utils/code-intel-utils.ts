import type { IAgentRuntime } from '@elizaos/core';

/**
 * Max field lengths for sanitizing user-supplied data before storage.
 */
export const MAX_LENGTHS = {
  project: 128,
  file_path: 512,
  branch: 256,
  summary: 2048,
  category: 64,
};

/**
 * Truncate a string to a maximum length.
 */
export function truncate(value: string, maxLen: number): string {
  if (!value) return value;
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

/**
 * Check Bearer token auth against ITACHI_API_KEY setting.
 * Returns true if authorized, false (and sends 401) if not.
 */
export function checkAuth(
  req: any,
  res: any,
  runtime: IAgentRuntime,
): boolean {
  const apiKey = runtime.getSetting('ITACHI_API_KEY');
  if (!apiKey) return true; // no key configured = open access
  const headers = req.headers || {};
  const authHeader = headers['authorization'] || headers['Authorization'];
  const token =
    typeof authHeader === 'string'
      ? authHeader.replace(/^Bearer\s+/i, '')
      : '';
  if (token !== apiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * Sanitize an error for safe inclusion in HTTP responses.
 */
export function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
