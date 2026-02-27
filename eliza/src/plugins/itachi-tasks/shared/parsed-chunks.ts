/** Discriminated union for parsed stream-json output chunks */
export type ParsedChunk =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; toolName: string; summary: string; toolId: string }
  | { kind: 'ask_user'; toolId: string; question: string; options: string[] }
  | { kind: 'hook_response'; text: string }
  | { kind: 'result'; subtype: string; cost?: string; duration?: string }
  | { kind: 'passthrough'; text: string };

/**
 * Parse options from an AskUserQuestion question string.
 * Extracts structured choices from common patterns in the text.
 */
export function parseAskUserOptions(question: string): string[] {
  // Pattern 1: numbered list "1. Yes 2. No" or "1) Option A 2) Option B"
  const numbered = question.match(/\d+[.)]\s*([^\d\n]+)/g);
  if (numbered && numbered.length >= 2) {
    return numbered.map(m => m.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean);
  }
  // Pattern 2: parenthetical slash-separated "(yes/no)" or "(a/b/c)"
  const paren = question.match(/\(([^)]+\/[^)]+)\)/);
  if (paren) {
    return paren[1].split('/').map(s => s.trim()).filter(Boolean);
  }
  // Default
  return ['Yes', 'No'];
}
