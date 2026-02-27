/**
 * Tests for session output parsing, stream-json mode, and related utilities.
 * Run with: bun test src/plugins/itachi-tasks/__tests__/session-output.test.ts
 */
import { describe, test, expect } from 'bun:test';
import {
  parseStreamJsonLine,
  wrapStreamJsonInput,
  createNdjsonParser,
} from '../actions/interactive-session.js';
import type { ParsedChunk } from '../shared/parsed-chunks.js';
import { parseAskUserOptions } from '../shared/parsed-chunks.js';

// ── parseStreamJsonLine ─────────────────────────────────────────────

describe('parseStreamJsonLine', () => {
  test('parses assistant text message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will fix the bug now.' }],
      },
    });
    const chunks = parseStreamJsonLine(line);
    expect(chunks).toEqual([{ kind: 'text', text: 'I will fix the bug now.' }]);
  });

  test('silently skips tool_use (Read, Edit, Bash, etc.)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool_123',
          name: 'Read',
          input: { file_path: '/src/index.ts' },
        }],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  test('keeps text but skips tool_use in mixed content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read the file.' },
          { type: 'tool_use', id: 'tool_456', name: 'Read', input: { file_path: '/foo.ts' } },
        ],
      },
    });
    const chunks = parseStreamJsonLine(line);
    expect(chunks).toEqual([{ kind: 'text', text: 'Let me read the file.' }]);
  });

  test('skips tool results (user messages)', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool_123',
          content: 'const x = 42;\nexport default x;',
        }],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  test('skips long tool results too', () => {
    const longContent = 'x'.repeat(1000);
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool_123',
          content: longContent,
        }],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  test('parses result message', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'abc-123',
      total_cost_usd: 0.0532,
      duration_ms: 45000,
    });
    const chunks = parseStreamJsonLine(line);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      kind: 'result',
      subtype: 'success',
      cost: '$0.0532',
      duration: '45s',
    });
  });

  test('returns [] for system messages', () => {
    const line = JSON.stringify({ type: 'system', message: 'Initializing...' });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  test('returns [] for empty/whitespace lines', () => {
    expect(parseStreamJsonLine('')).toEqual([]);
    expect(parseStreamJsonLine('   ')).toEqual([]);
    expect(parseStreamJsonLine('\n')).toEqual([]);
  });

  test('returns [] for malformed JSON starting with {', () => {
    expect(parseStreamJsonLine('{ broken json')).toEqual([]);
  });

  test('passes through non-JSON text as passthrough', () => {
    const chunks1 = parseStreamJsonLine('Starting claude...');
    expect(chunks1).toEqual([{ kind: 'passthrough', text: 'Starting claude...' }]);

    const chunks2 = parseStreamJsonLine('Error: command not found');
    expect(chunks2).toEqual([{ kind: 'passthrough', text: 'Error: command not found' }]);
  });

  test('silently skips Bash tool call', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool_789',
          name: 'Bash',
          input: { command: 'npm run build && npm test' },
        }],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  test('silently skips Grep tool call', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool_000',
          name: 'Grep',
          input: { pattern: 'TODO', path: '/src' },
        }],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  test('returns [] for empty assistant content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [] },
    });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  test('skips tool_result with array content (user message)', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool_123',
          content: [
            { type: 'text', text: 'Line 1' },
            { type: 'text', text: 'Line 2' },
          ],
        }],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  test('parses hook_response as hook_response chunk', () => {
    const line = JSON.stringify({
      type: 'hook_response',
      stdout: '=== Session Briefing ===\nRecent changes...\n=== End ===',
    });
    const chunks = parseStreamJsonLine(line);
    expect(chunks).toEqual([{
      kind: 'hook_response',
      text: '=== Session Briefing ===\nRecent changes...\n=== End ===',
    }]);
  });

  test('skips hook_response with empty stdout', () => {
    const line = JSON.stringify({ type: 'hook_response', stdout: '   ' });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  test('parses AskUserQuestion as ask_user chunk with structured options', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'ask_001',
          name: 'AskUserQuestion',
          input: {
            questions: [{
              question: 'Which approach should I use?',
              options: [
                { label: 'Option A', description: 'First approach' },
                { label: 'Option B', description: 'Second approach' },
              ],
            }],
          },
        }],
      },
    });
    const chunks = parseStreamJsonLine(line);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      kind: 'ask_user',
      toolId: 'ask_001',
      question: 'Which approach should I use?',
      options: ['Option A', 'Option B'],
    });
  });

  test('parses AskUserQuestion with heuristic option parsing', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'ask_002',
          name: 'AskUserQuestion',
          input: {
            questions: [{
              question: 'Proceed? (yes/no)',
              options: [],
            }],
          },
        }],
      },
    });
    const chunks = parseStreamJsonLine(line);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      kind: 'ask_user',
      options: ['yes', 'no'],
    });
  });

  test('skips init, hook_started, and rate_limit_event', () => {
    expect(parseStreamJsonLine(JSON.stringify({ type: 'init', session_id: 'x' }))).toEqual([]);
    expect(parseStreamJsonLine(JSON.stringify({ type: 'hook_started', hook: 'test' }))).toEqual([]);
    expect(parseStreamJsonLine(JSON.stringify({ type: 'rate_limit_event', retry_after: 5 }))).toEqual([]);
  });
});

// ── wrapStreamJsonInput ─────────────────────────────────────────────

describe('wrapStreamJsonInput', () => {
  test('wraps text as JSON message with content blocks and newline', () => {
    const result = wrapStreamJsonInput('fix the bug');
    const parsed = JSON.parse(result.trim());
    expect(parsed.type).toBe('user');
    expect(parsed.message.role).toBe('user');
    expect(parsed.message.content).toEqual([{ type: 'text', text: 'fix the bug' }]);
    expect(result.endsWith('\n')).toBe(true);
  });

  test('handles special characters', () => {
    const result = wrapStreamJsonInput('use "quotes" and \'apostrophes\'');
    const parsed = JSON.parse(result.trim());
    expect(parsed.message.content[0].text).toBe('use "quotes" and \'apostrophes\'');
  });

  test('handles multiline input', () => {
    const result = wrapStreamJsonInput('line 1\nline 2\nline 3');
    const parsed = JSON.parse(result.trim());
    expect(parsed.message.content[0].text).toBe('line 1\nline 2\nline 3');
  });
});

// ── createNdjsonParser ──────────────────────────────────────────────

describe('createNdjsonParser', () => {
  test('emits typed chunks for complete lines', () => {
    const results: ParsedChunk[] = [];
    const parser = createNdjsonParser((chunk) => results.push(chunk));

    const msg = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    });

    parser(msg + '\n');
    expect(results).toEqual([{ kind: 'text', text: 'hello' }]);
  });

  test('handles split chunks (buffering)', () => {
    const results: ParsedChunk[] = [];
    const parser = createNdjsonParser((chunk) => results.push(chunk));

    const fullLine = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'buffered output' }] },
    });

    // Split the JSON line in the middle
    const mid = Math.floor(fullLine.length / 2);
    parser(fullLine.substring(0, mid));
    expect(results).toEqual([]); // Not complete yet

    parser(fullLine.substring(mid) + '\n');
    expect(results).toEqual([{ kind: 'text', text: 'buffered output' }]);
  });

  test('handles multiple lines in one chunk', () => {
    const results: ParsedChunk[] = [];
    const parser = createNdjsonParser((chunk) => results.push(chunk));

    const line1 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
    });

    parser(line1 + '\n' + line2 + '\n');
    expect(results).toEqual([
      { kind: 'text', text: 'first' },
      { kind: 'text', text: 'second' },
    ]);
  });

  test('skips system messages and empty lines', () => {
    const results: ParsedChunk[] = [];
    const parser = createNdjsonParser((chunk) => results.push(chunk));

    const system = JSON.stringify({ type: 'system', message: 'init' });
    const text = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'visible' }] },
    });

    parser(system + '\n\n' + text + '\n');
    expect(results).toEqual([{ kind: 'text', text: 'visible' }]);
  });

  test('handles trailing incomplete line across multiple calls', () => {
    const results: ParsedChunk[] = [];
    const parser = createNdjsonParser((chunk) => results.push(chunk));

    const line1 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'msg1' }] },
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'msg2' }] },
    });

    // First chunk: complete line1 + partial line2
    parser(line1 + '\n' + line2.substring(0, 10));
    expect(results).toEqual([{ kind: 'text', text: 'msg1' }]);

    // Second chunk: rest of line2
    parser(line2.substring(10) + '\n');
    expect(results).toEqual([
      { kind: 'text', text: 'msg1' },
      { kind: 'text', text: 'msg2' },
    ]);
  });

  test('does not emit chunks for tool_use lines', () => {
    const results: ParsedChunk[] = [];
    const parser = createNdjsonParser((chunk) => results.push(chunk));

    const toolLine = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    const textLine = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    });

    parser(toolLine + '\n' + textLine + '\n');
    expect(results).toEqual([{ kind: 'text', text: 'done' }]);
  });
});

// ── parseAskUserOptions ─────────────────────────────────────────────

describe('parseAskUserOptions', () => {
  test('parses numbered list (dot notation)', () => {
    const options = parseAskUserOptions('Choose: 1. Alpha 2. Beta 3. Gamma');
    expect(options).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  test('parses numbered list (paren notation)', () => {
    const options = parseAskUserOptions('Pick one: 1) First 2) Second');
    expect(options).toEqual(['First', 'Second']);
  });

  test('parses slash-separated in parens', () => {
    const options = parseAskUserOptions('Continue? (yes/no)');
    expect(options).toEqual(['yes', 'no']);
  });

  test('parses multi-option slash-separated', () => {
    const options = parseAskUserOptions('Color? (red/green/blue)');
    expect(options).toEqual(['red', 'green', 'blue']);
  });

  test('defaults to Yes/No when no pattern matched', () => {
    const options = parseAskUserOptions('Should I proceed with this?');
    expect(options).toEqual(['Yes', 'No']);
  });
});
