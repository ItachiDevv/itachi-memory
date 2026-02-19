import { DEFAULT_REPO_BASES } from './repo-utils.js';

/**
 * Resolve the starting directory for an SSH target.
 * Checks per-target env var first, falls back to DEFAULT_REPO_BASES.
 */
export function getStartingDir(target: string): string {
  const envKey = `ITACHI_SSH_${target.toUpperCase()}_START_DIR`;
  return process.env[envKey] || DEFAULT_REPO_BASES[target] || '~';
}
