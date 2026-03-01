import { describe, it, expect, beforeEach } from 'bun:test';

// ============================================================
// Tests for stream-json parsing utilities in interactive-session.ts
// ============================================================

let parseStreamJsonLine: (line: string) => any[];
let wrapStreamJsonInput: (text: string) => string;
let createNdjsonParser: (onChunk: (chunk: any) => void) => (data: string) => void;

beforeEach(async () => {
  const mod = await import('../plugins/itachi-tasks/actions/interactive-session.js');
  parseStreamJsonLine = mod.parseStreamJsonLine;
  wrapStreamJsonInput = mod.wrapStreamJsonInput;
  createNdjsonParser = mod.createNdjsonParser;
});

// ── parseStreamJsonLine ─────────────────────────────────────────────

describe('parseStreamJsonLine', () => {
  it('should return empty array for empty string', () => {
    expect(parseStreamJsonLine('')).toEqual([]);
  });

  it('should return empty array for whitespace-only string', () => {
    expect(parseStreamJsonLine('   \t  ')).toEqual([]);
  });

  it('should return passthrough chunk for non-JSON non-brace text', () => {
    const result = parseStreamJsonLine('some plain text output');
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('passthrough');
    expect(result[0].text).toBe('some plain text output');
  });

  it('should return empty array for invalid JSON starting with brace', () => {
    const result = parseStreamJsonLine('{broken json here');
    expect(result).toEqual([]);
  });

  it('should return empty array for valid JSON non-object (string)', () => {
    const result = parseStreamJsonLine('"just a string"');
    expect(result).toEqual([]);
  });

  it('should return empty array for valid JSON non-object (number)', () => {
    const result = parseStreamJsonLine('42');
    expect(result).toEqual([]);
  });

  it('should return empty array for valid JSON null', () => {
    const result = parseStreamJsonLine('null');
    expect(result).toEqual([]);
  });

  // ── hook_response ──

  it('should parse hook_response with stdout', () => {
    const line = JSON.stringify({ type: 'hook_response', stdout: '  Memory context loaded  ' });
    const result = parseStreamJsonLine(line);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('hook_response');
    expect(result[0].text).toBe('Memory context loaded');
  });

  it('should return empty array for hook_response with empty stdout', () => {
    const line = JSON.stringify({ type: 'hook_response', stdout: '   ' });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  it('should return empty array for hook_response with no stdout', () => {
    const line = JSON.stringify({ type: 'hook_response' });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  // ── assistant messages ──

  it('should parse assistant message with text content block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello from Claude' }],
      },
    });
    const result = parseStreamJsonLine(line);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('text');
    expect(result[0].text).toBe('Hello from Claude');
  });

  it('should skip non-AskUser tool_use blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', id: 'tool-1', input: { file_path: '/foo.ts' } },
        ],
      },
    });
    const result = parseStreamJsonLine(line);
    expect(result).toEqual([]);
  });

  it('should parse AskUserQuestion with questions array containing options', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            id: 'ask-1',
            input: {
              questions: [
                {
                  question: 'Which framework?',
                  options: [{ label: 'React' }, { label: 'Vue' }, { label: 'Svelte' }],
                },
              ],
            },
          },
        ],
      },
    });
    const result = parseStreamJsonLine(line);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('ask_user');
    expect(result[0].toolId).toBe('ask-1');
    expect(result[0].question).toBe('Which framework?');
    expect(result[0].options).toEqual(['React', 'Vue', 'Svelte']);
  });

  it('should parse AskUserQuestion with multiple questions', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            id: 'ask-2',
            input: {
              questions: [
                { question: 'First question?', options: [{ label: 'A' }, { label: 'B' }] },
                { question: 'Second question?', options: [{ label: 'X' }, { label: 'Y' }] },
              ],
            },
          },
        ],
      },
    });
    const result = parseStreamJsonLine(line);
    expect(result).toHaveLength(2);
    expect(result[0].question).toBe('First question?');
    expect(result[1].question).toBe('Second question?');
  });

  it('should fall back to single question format when questions array is absent', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            id: 'ask-3',
            input: {
              question: 'Continue? (yes/no)',
            },
          },
        ],
      },
    });
    const result = parseStreamJsonLine(line);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('ask_user');
    expect(result[0].toolId).toBe('ask-3');
    expect(result[0].question).toBe('Continue? (yes/no)');
    // parseAskUserOptions should extract yes/no from the paren pattern
    expect(result[0].options).toContain('yes');
    expect(result[0].options).toContain('no');
  });

  it('should use default question when AskUserQuestion has no question field', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            id: 'ask-4',
            input: {},
          },
        ],
      },
    });
    const result = parseStreamJsonLine(line);
    expect(result).toHaveLength(1);
    expect(result[0].question).toBe('Choose an option:');
  });

  it('should fall back to parseAskUserOptions when options have fewer than 2 labels', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            id: 'ask-5',
            input: {
              questions: [
                { question: 'Pick one (alpha/beta)', options: [{ label: 'OnlyOne' }] },
              ],
            },
          },
        ],
      },
    });
    const result = parseStreamJsonLine(line);
    expect(result).toHaveLength(1);
    // Only 1 label, so falls back to parseAskUserOptions which finds (alpha/beta)
    expect(result[0].options).toContain('alpha');
    expect(result[0].options).toContain('beta');
  });

  // ── user messages ──

  it('should return empty array for user type messages', () => {
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  // ── result messages ──

  it('should parse result with cost and duration', () => {
    const line = JSON.stringify({
      type: 'result',
      total_cost_usd: 0.1234,
      duration_ms: 45000,
      subtype: 'success',
    });
    const result = parseStreamJsonLine(line);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('result');
    expect(result[0].subtype).toBe('success');
    expect(result[0].cost).toBe('$0.1234');
    expect(result[0].duration).toBe('45s');
  });

  it('should parse result without cost or duration', () => {
    const line = JSON.stringify({ type: 'result' });
    const result = parseStreamJsonLine(line);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('result');
    expect(result[0].subtype).toBe('done');
    expect(result[0].cost).toBeUndefined();
    expect(result[0].duration).toBeUndefined();
  });

  // ── rate_limit_event ──

  it('should parse rate_limit_event with retry_after', () => {
    const line = JSON.stringify({ type: 'rate_limit_event', retry_after: 30 });
    const result = parseStreamJsonLine(line);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('rate_limit');
    expect(result[0].retryAfter).toBe(30);
  });

  it('should default retryAfter to 0 when not a number', () => {
    const line = JSON.stringify({ type: 'rate_limit_event', retry_after: 'unknown' });
    const result = parseStreamJsonLine(line);
    expect(result).toHaveLength(1);
    expect(result[0].retryAfter).toBe(0);
  });

  // ── system / init / unknown ──

  it('should return empty array for system type', () => {
    const line = JSON.stringify({ type: 'system', message: 'starting' });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  it('should return empty array for init type', () => {
    const line = JSON.stringify({ type: 'init', session_id: 'abc' });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  it('should return empty array for unknown type', () => {
    const line = JSON.stringify({ type: 'something_new', data: 123 });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  // ── multiple content blocks ──

  it('should produce multiple chunks from multiple content blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'First paragraph' },
          { type: 'text', text: 'Second paragraph' },
          { type: 'tool_use', name: 'Bash', id: 'tool-x', input: { command: 'ls' } },
          { type: 'text', text: 'Third paragraph' },
        ],
      },
    });
    const result = parseStreamJsonLine(line);
    // 3 text chunks (tool_use for Bash is skipped)
    expect(result).toHaveLength(3);
    expect(result[0].kind).toBe('text');
    expect(result[0].text).toBe('First paragraph');
    expect(result[1].text).toBe('Second paragraph');
    expect(result[2].text).toBe('Third paragraph');
  });

  it('should return empty array for assistant with no message.content', () => {
    const line = JSON.stringify({ type: 'assistant', message: {} });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  it('should skip text blocks with empty text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '' }] },
    });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });
});

// ── wrapStreamJsonInput ─────────────────────────────────────────────

describe('wrapStreamJsonInput', () => {
  it('should wrap simple text into correct JSON structure', () => {
    const result = wrapStreamJsonInput('hello');
    const parsed = JSON.parse(result.trim());
    expect(parsed.type).toBe('user');
    expect(parsed.message.role).toBe('user');
    expect(parsed.message.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('should properly escape special characters', () => {
    const text = 'line1\nline2\t"quoted"\\backslash';
    const result = wrapStreamJsonInput(text);
    const parsed = JSON.parse(result.trim());
    expect(parsed.message.content[0].text).toBe(text);
  });

  it('should end with a newline character', () => {
    const result = wrapStreamJsonInput('test');
    expect(result.endsWith('\n')).toBe(true);
  });

  it('should produce valid JSON that can be parsed back', () => {
    const result = wrapStreamJsonInput('complex "input" with {braces}');
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.message.content).toHaveLength(1);
    expect(parsed.message.content[0].type).toBe('text');
  });

  it('should handle empty string input', () => {
    const result = wrapStreamJsonInput('');
    const parsed = JSON.parse(result.trim());
    expect(parsed.message.content[0].text).toBe('');
  });
});

// ── createNdjsonParser ──────────────────────────────────────────────

describe('createNdjsonParser', () => {
  it('should call onChunk for a single complete NDJSON line', () => {
    const chunks: any[] = [];
    const parser = createNdjsonParser((chunk) => chunks.push(chunk));

    const line = JSON.stringify({ type: 'hook_response', stdout: 'hello' }) + '\n';
    parser(line);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBe('hook_response');
    expect(chunks[0].text).toBe('hello');
  });

  it('should buffer incomplete lines and emit when complete', () => {
    const chunks: any[] = [];
    const parser = createNdjsonParser((chunk) => chunks.push(chunk));

    const full = JSON.stringify({ type: 'hook_response', stdout: 'buffered' });
    // Split in the middle
    const part1 = full.substring(0, 10);
    const part2 = full.substring(10) + '\n';

    parser(part1);
    expect(chunks).toHaveLength(0); // Not yet complete

    parser(part2);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('buffered');
  });

  it('should handle multiple lines in a single chunk', () => {
    const chunks: any[] = [];
    const parser = createNdjsonParser((chunk) => chunks.push(chunk));

    const line1 = JSON.stringify({ type: 'hook_response', stdout: 'one' });
    const line2 = JSON.stringify({ type: 'hook_response', stdout: 'two' });
    parser(line1 + '\n' + line2 + '\n');

    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe('one');
    expect(chunks[1].text).toBe('two');
  });

  it('should skip empty lines between NDJSON lines', () => {
    const chunks: any[] = [];
    const parser = createNdjsonParser((chunk) => chunks.push(chunk));

    const line = JSON.stringify({ type: 'hook_response', stdout: 'only' });
    parser('\n\n' + line + '\n\n');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('only');
  });

  it('should not emit incomplete trailing data until next chunk arrives', () => {
    const chunks: any[] = [];
    const parser = createNdjsonParser((chunk) => chunks.push(chunk));

    const full = JSON.stringify({ type: 'hook_response', stdout: 'trailing' });
    // Send without trailing newline
    parser(full);
    expect(chunks).toHaveLength(0);

    // Send the newline + more data
    parser('\n');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('trailing');
  });

  it('should correctly emit passthrough chunks for non-JSON text lines', () => {
    const chunks: any[] = [];
    const parser = createNdjsonParser((chunk) => chunks.push(chunk));

    parser('some plain text\n');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBe('passthrough');
    expect(chunks[0].text).toBe('some plain text');
  });

  it('should handle interleaved JSON and non-JSON lines', () => {
    const chunks: any[] = [];
    const parser = createNdjsonParser((chunk) => chunks.push(chunk));

    const jsonLine = JSON.stringify({ type: 'hook_response', stdout: 'json' });
    parser('plain text\n' + jsonLine + '\nanother plain\n');

    expect(chunks).toHaveLength(3);
    expect(chunks[0].kind).toBe('passthrough');
    expect(chunks[1].kind).toBe('hook_response');
    expect(chunks[2].kind).toBe('passthrough');
  });
});
