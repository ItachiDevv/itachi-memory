import { createHmac, timingSafeEqual } from 'node:crypto';
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
  // Extract message from Error instances or Supabase PostgrestError objects
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message: unknown }).message)
        : '';

  if (!msg) return 'Internal server error';

  // Hide Supabase/Postgres internals
  if (msg.includes('schema cache') || msg.includes('column') || msg.includes('relation')) {
    return 'Internal database error';
  }
  if (msg.includes('invalid input syntax')) {
    return 'Invalid input format';
  }
  return msg;
}

type JwtPayload = Record<string, unknown> & { exp?: number; iat?: number };

type JwtVerifyResult =
  | { valid: true; payload: JwtPayload }
  | { valid: false; reason: 'expired' | 'invalid' };

/**
 * Verify an HS256 JWT using Node.js built-in crypto.
 * Returns the decoded payload if valid, or a typed error reason.
 */
export function verifyJwt(token: string, secret: string): JwtVerifyResult {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return { valid: false, reason: 'invalid' };

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify HMAC-SHA256 signature using timing-safe comparison
    const signingInput = `${headerB64}.${payloadB64}`;
    const expected = createHmac('sha256', secret).update(signingInput).digest();
    const actual = Buffer.from(signatureB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { valid: false, reason: 'invalid' };
    }

    // Decode and parse payload
    const payloadJson = Buffer.from(
      payloadB64.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    const payload = JSON.parse(payloadJson) as JwtPayload;

    // Check token expiry
    if (typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) > payload.exp) {
      return { valid: false, reason: 'expired' };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false, reason: 'invalid' };
  }
}

/**
 * Check JWT Bearer token auth. Returns true if authorized.
 * Uses ITACHI_API_KEY as the HS256 signing secret.
 * If ITACHI_API_KEY is not set, auth is skipped (open access).
 *
 * Error responses:
 *   401 { error: 'Missing authorization token' }  — no Bearer token in header
 *   401 { error: 'Token has expired' }            — valid JWT but past exp claim
 *   401 { error: 'Invalid token' }                — bad signature or malformed JWT
 */
export function checkAuth(
  req: { headers: Record<string, string | string[] | undefined> },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  runtime: IAgentRuntime
): boolean {
  const jwtSecret = runtime.getSetting('ITACHI_API_KEY');
  if (!jwtSecret) return true; // no secret configured = open access

  // Extract Bearer token from Authorization header
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  const bearerToken =
    typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';

  if (!bearerToken) {
    res.status(401).json({ error: 'Missing authorization token' });
    return false;
  }

  const result = verifyJwt(bearerToken, jwtSecret);
  if (result.valid) return true;

  if (result.reason === 'expired') {
    res.status(401).json({ error: 'Token has expired' });
  } else {
    res.status(401).json({ error: 'Invalid token' });
  }
  return false;
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
