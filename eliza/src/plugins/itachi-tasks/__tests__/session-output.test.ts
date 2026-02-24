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
    expect(parseStreamJsonLine(line)).toBe('I will fix the bug now.');
  });

  test('parses assistant tool_use message', () => {
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
    const result = parseStreamJsonLine(line);
    expect(result).toContain('[Read]');
    expect(result).toContain('/src/index.ts');
  });

  test('parses mixed text + tool_use content', () => {
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
    const result = parseStreamJsonLine(line)!;
    expect(result).toContain('Let me read the file.');
    expect(result).toContain('[Read]');
    expect(result).toContain('/foo.ts');
  });

  test('parses tool result (user message with tool_result)', () => {
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
    const result = parseStreamJsonLine(line);
    expect(result).toContain('const x = 42;');
  });

  test('truncates long tool results', () => {
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
    const result = parseStreamJsonLine(line)!;
    expect(result.length).toBeLessThan(longContent.length);
    expect(result).toContain('1000 chars total');
  });

  test('parses result message', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'abc-123',
      total_cost_usd: 0.0532,
      duration_ms: 45000,
    });
    const result = parseStreamJsonLine(line)!;
    expect(result).toContain('Session success');
    expect(result).toContain('$0.0532');
    expect(result).toContain('45s');
  });

  test('returns null for system messages', () => {
    const line = JSON.stringify({ type: 'system', message: 'Initializing...' });
    expect(parseStreamJsonLine(line)).toBeNull();
  });

  test('returns null for empty/whitespace lines', () => {
    expect(parseStreamJsonLine('')).toBeNull();
    expect(parseStreamJsonLine('   ')).toBeNull();
    expect(parseStreamJsonLine('\n')).toBeNull();
  });

  test('returns null for malformed JSON starting with {', () => {
    expect(parseStreamJsonLine('{ broken json')).toBeNull();
  });

  test('passes through non-JSON text (from wrapper scripts)', () => {
    expect(parseStreamJsonLine('Starting claude...')).toBe('Starting claude...');
    expect(parseStreamJsonLine('Error: command not found')).toBe('Error: command not found');
  });

  test('handles Bash tool call summary', () => {
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
    const result = parseStreamJsonLine(line)!;
    expect(result).toContain('[Bash]');
    expect(result).toContain('npm run build');
  });

  test('handles Grep tool call summary', () => {
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
    const result = parseStreamJsonLine(line)!;
    expect(result).toContain('[Grep]');
    expect(result).toContain('TODO');
    expect(result).toContain('/src');
  });

  test('handles empty assistant content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [] },
    });
    expect(parseStreamJsonLine(line)).toBeNull();
  });

  test('handles tool_result with array content', () => {
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
    const result = parseStreamJsonLine(line)!;
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
  });
});

// ── wrapStreamJsonInput ─────────────────────────────────────────────

describe('wrapStreamJsonInput', () => {
  test('wraps text as JSON message with newline', () => {
    const result = wrapStreamJsonInput('fix the bug');
    const parsed = JSON.parse(result.trim());
    expect(parsed.type).toBe('user');
    expect(parsed.message.role).toBe('user');
    expect(parsed.message.content).toBe('fix the bug');
    expect(result.endsWith('\n')).toBe(true);
  });

  test('handles special characters', () => {
    const result = wrapStreamJsonInput('use "quotes" and \'apostrophes\'');
    const parsed = JSON.parse(result.trim());
    expect(parsed.message.content).toBe('use "quotes" and \'apostrophes\'');
  });

  test('handles multiline input', () => {
    const result = wrapStreamJsonInput('line 1\nline 2\nline 3');
    const parsed = JSON.parse(result.trim());
    expect(parsed.message.content).toBe('line 1\nline 2\nline 3');
  });
});

// ── createNdjsonParser ──────────────────────────────────────────────

describe('createNdjsonParser', () => {
  test('parses complete lines', () => {
    const results: string[] = [];
    const parser = createNdjsonParser((line) => results.push(line));

    const msg = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    });

    parser(msg + '\n');
    expect(results).toEqual(['hello']);
  });

  test('handles split chunks (buffering)', () => {
    const results: string[] = [];
    const parser = createNdjsonParser((line) => results.push(line));

    const fullLine = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'buffered output' }] },
    });

    // Split the JSON line in the middle
    const mid = Math.floor(fullLine.length / 2);
    parser(fullLine.substring(0, mid));
    expect(results).toEqual([]); // Not complete yet

    parser(fullLine.substring(mid) + '\n');
    expect(results).toEqual(['buffered output']);
  });

  test('handles multiple lines in one chunk', () => {
    const results: string[] = [];
    const parser = createNdjsonParser((line) => results.push(line));

    const line1 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
    });

    parser(line1 + '\n' + line2 + '\n');
    expect(results).toEqual(['first', 'second']);
  });

  test('skips system messages and empty lines', () => {
    const results: string[] = [];
    const parser = createNdjsonParser((line) => results.push(line));

    const system = JSON.stringify({ type: 'system', message: 'init' });
    const text = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'visible' }] },
    });

    parser(system + '\n\n' + text + '\n');
    expect(results).toEqual(['visible']);
  });

  test('handles trailing incomplete line across multiple calls', () => {
    const results: string[] = [];
    const parser = createNdjsonParser((line) => results.push(line));

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
    expect(results).toEqual(['msg1']);

    // Second chunk: rest of line2
    parser(line2.substring(10) + '\n');
    expect(results).toEqual(['msg1', 'msg2']);
  });
});
