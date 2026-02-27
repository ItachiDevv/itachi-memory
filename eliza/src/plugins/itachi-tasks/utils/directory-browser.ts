import type { SSHService } from '../services/ssh-service.js';

// ── Browsing session state ──────────────────────────────────────────
export interface BrowsingSession {
  topicId: number;
  target: string;           // SSH target name
  currentPath: string;
  prompt: string;           // Original session prompt
  engineCommand: string;    // Resolved CLI wrapper (itachi/itachic/itachig)
  createdAt: number;
  history: string[];        // For ".." navigation
  lastDirListing: string[]; // Cached for numeric selection validation
}

/** Global map of browsing sessions, keyed by topicId */
export const browsingSessionMap = new Map<number, BrowsingSession>();

// ── SSH directory listing ───────────────────────────────────────────
export async function listRemoteDirectory(
  sshService: SSHService,
  target: string,
  path: string,
): Promise<{ dirs: string[]; error?: string }> {
  try {
    const isWindows = sshService.isWindowsTarget(target);
    const cmd = isWindows
      ? `Get-ChildItem -Directory -Path '${path}' -ErrorAction SilentlyContinue | Select-Object -First 30 -ExpandProperty Name`
      : `ls -1 -p ${path} 2>/dev/null | grep '/$' | head -30`;

    const result = await sshService.exec(target, cmd, 10_000);
    if (!result.success && !result.stdout) {
      return { dirs: [], error: result.stderr || 'Failed to list directory' };
    }
    const dirs = (result.stdout || '')
      .split('\n')
      .map(d => isWindows ? d.trim() : d.replace(/\/$/, '').trim())
      .filter(Boolean);
    return { dirs };
  } catch (err) {
    return { dirs: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Format directory listing for Telegram ───────────────────────────
export function formatDirectoryListing(path: string, dirs: string[], _target: string): string {
  const lines: string[] = [
    `\ud83d\udcc2 ${path}`,
    '',
  ];

  if (dirs.length === 0) {
    lines.push('(no subdirectories)');
  } else {
    for (let i = 0; i < dirs.length; i++) {
      lines.push(`${i + 1}. \ud83d\udcc1 ${dirs[i]}`);
    }
  }

  lines.push('', 'Use buttons below, or type a full path');
  return lines.join('\n');
}

/** Build inline keyboard for directory browsing in Telegram topics */
export function buildBrowsingKeyboard(
  dirs: string[],
  canGoBack: boolean,
): Array<Array<{ text: string; callback_data: string }>> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  // Start here + Go back row
  const topRow: Array<{ text: string; callback_data: string }> = [
    { text: '\u2705 Start here', callback_data: 'browse:start' },
  ];
  if (canGoBack) {
    topRow.push({ text: '\u2b06 Go back', callback_data: 'browse:back' });
  }
  rows.push(topRow);

  // Directory buttons, 2 per row
  for (let i = 0; i < dirs.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = [];
    row.push({ text: `\ud83d\udcc1 ${dirs[i]}`, callback_data: `browse:${i}` });
    if (i + 1 < dirs.length) {
      row.push({ text: `\ud83d\udcc1 ${dirs[i + 1]}`, callback_data: `browse:${i + 1}` });
    }
    rows.push(row);
  }

  return rows;
}

// ── Parse browsing input ────────────────────────────────────────────
export type BrowsingAction =
  | { action: 'start' }
  | { action: 'navigate'; path: string }
  | { action: 'error'; message: string };

export function parseBrowsingInput(input: string, session: BrowsingSession): BrowsingAction {
  const trimmed = input.trim();

  // Start session
  if (trimmed === '0' || /^(go|start)$/i.test(trimmed)) {
    return { action: 'start' };
  }

  // Go up
  if (trimmed === '..') {
    const parts = session.currentPath.replace(/\/+$/, '').split('/');
    if (parts.length <= 1 || session.currentPath === '~' || session.currentPath === '/') {
      return { action: 'error', message: 'Already at root. Type a full path or select a directory.' };
    }
    parts.pop();
    const parent = parts.join('/') || '/';
    return { action: 'navigate', path: parent };
  }

  // Absolute or home-relative path
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) {
    return { action: 'navigate', path: trimmed };
  }

  // Numeric selection
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= session.lastDirListing.length) {
    const selected = session.lastDirListing[num - 1];
    const base = session.currentPath.replace(/\/+$/, '');
    return { action: 'navigate', path: `${base}/${selected}` };
  }

  if (!isNaN(num)) {
    return { action: 'error', message: `Invalid selection. Enter 0-${session.lastDirListing.length}, "..", or a full path.` };
  }

  return { action: 'error', message: `Unrecognized input. Enter a number, "..", or a full path.` };
}

// ── Stale session cleanup ───────────────────────────────────────────
const BROWSING_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function cleanupStaleBrowsingSessions(): void {
  const now = Date.now();
  for (const [topicId, session] of browsingSessionMap) {
    if (now - session.createdAt > BROWSING_TTL_MS) {
      browsingSessionMap.delete(topicId);
    }
  }
}
