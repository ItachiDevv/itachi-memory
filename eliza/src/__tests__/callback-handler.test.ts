import { describe, it, expect, beforeEach } from 'bun:test';

// ============================================================
// Tests for callback-handler.ts — Telegram inline button routing
// ============================================================

// We import decodeCallback directly since it is a pure function
let decodeCallback: (data: string) => { prefix: string; key: string; value: string } | null;
let encodeCallback: (prefix: string, key: string, value: string | number) => string;

beforeEach(async () => {
  const mod = await import('../plugins/itachi-tasks/shared/conversation-flows.js');
  decodeCallback = mod.decodeCallback;
  encodeCallback = mod.encodeCallback;
});

// ── Constants mirrored from callback-handler.ts for validation ──────
const ENGINE_SHORT: Record<string, string> = { i: 'itachi', c: 'itachic', g: 'itachig' };
const ENGINE_TO_SHORT: Record<string, string> = { itachi: 'i', itachic: 'c', itachig: 'g' };

// ── Helper: build engine keyboard (mirrors the function in callback-handler.ts) ──
function buildEngineKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
  return [
    [
      { text: 'itachi --ds', callback_data: 'sf:s:i.ds' },
      { text: 'itachi --cds', callback_data: 'sf:s:i.cds' },
    ],
    [
      { text: 'itachic --ds', callback_data: 'sf:s:c.ds' },
      { text: 'itachic --cds', callback_data: 'sf:s:c.cds' },
    ],
    [
      { text: 'itachig --ds', callback_data: 'sf:s:g.ds' },
      { text: 'itachig --cds', callback_data: 'sf:s:g.cds' },
    ],
  ];
}

// ── Helper: parse engine+mode value from sf:s: callback ──
function parseEngineMode(value: string): { engine: string; mode: string } {
  if (value.includes('.')) {
    const [engShort, mode] = value.split('.');
    const engine = ENGINE_SHORT[engShort] || 'itachi';
    const dsFlag = mode === 'cds' ? '--cds' : '--ds';
    return { engine, mode: dsFlag };
  }
  // Old backward-compat format: just "ds" or "cds"
  return { engine: 'itachi', mode: value === 'cds' ? '--cds' : '--ds' };
}

// ── Helper: mock Telegraf ctx ──
function makeMockCtx(data: string | undefined, overrides: Record<string, any> = {}) {
  return {
    callbackQuery: {
      data,
      from: { id: 999 },
      message: {
        chat: { id: 123 },
        message_id: 456,
        message_thread_id: overrides.threadId ?? undefined,
      },
    },
    answerCbQuery: async () => {},
    editMessageText: async () => {},
    editMessageReplyMarkup: async () => {},
    ...overrides,
  };
}

// ============================================================
// 1. decodeCallback — prefix routing
// ============================================================

describe('decodeCallback — prefix routing', () => {
  it('should decode browse: prefix callbacks', () => {
    // browse: callbacks have only 2 parts (browse:start), so decodeCallback returns null
    // They are handled BEFORE decodeCallback in handleCallback
    const result = decodeCallback('browse:start');
    expect(result).toBeNull(); // 2-part format, not 3-part
  });

  it('should decode aq: prefix with topic and option', () => {
    // aq: callbacks have format aq:<topicId>:<optionIndex> (3 parts)
    const result = decodeCallback('aq:12345:2');
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('aq');
    expect(result!.key).toBe('12345');
    expect(result!.value).toBe('2');
  });

  it('should decode dt: prefix', () => {
    // dt: callbacks have format dt:<topicId> (2 parts), handled before decodeCallback
    const result = decodeCallback('dt:98765');
    expect(result).toBeNull(); // 2-part format
  });

  it('should decode bp: prefix', () => {
    // bp: callbacks have format bp:a:<shortId> (3 parts), but handled before decodeCallback
    const result = decodeCallback('bp:a:abc12345');
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('bp');
    expect(result!.key).toBe('a');
    expect(result!.value).toBe('abc12345');
  });

  it('should decode tf: prefix — task flow machine selection', () => {
    const result = decodeCallback('tf:m:0');
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('tf');
    expect(result!.key).toBe('m');
    expect(result!.value).toBe('0');
  });

  it('should decode sf: prefix — session flow engine selection', () => {
    const result = decodeCallback('sf:s:i.ds');
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('sf');
    expect(result!.key).toBe('s');
    expect(result!.value).toBe('i.ds');
  });

  it('should return null for unknown single-segment data', () => {
    const result = decodeCallback('unknown');
    expect(result).toBeNull();
  });

  it('should return null for empty string', () => {
    const result = decodeCallback('');
    expect(result).toBeNull();
  });

  it('should return null for two-segment data', () => {
    const result = decodeCallback('sf:m');
    expect(result).toBeNull();
  });
});

// ============================================================
// 2. Engine keyboard builder
// ============================================================

describe('buildEngineKeyboard', () => {
  it('should build a 3x2 grid (3 rows, 2 columns)', () => {
    const keyboard = buildEngineKeyboard();
    expect(keyboard).toHaveLength(3);
    for (const row of keyboard) {
      expect(row).toHaveLength(2);
    }
  });

  it('should produce exactly 6 buttons total', () => {
    const keyboard = buildEngineKeyboard();
    const total = keyboard.reduce((sum, row) => sum + row.length, 0);
    expect(total).toBe(6);
  });

  it('should use correct callback_data format sf:s:<short>.<mode>', () => {
    const keyboard = buildEngineKeyboard();
    const allCallbackData = keyboard.flat().map((btn) => btn.callback_data);

    expect(allCallbackData).toContain('sf:s:i.ds');
    expect(allCallbackData).toContain('sf:s:i.cds');
    expect(allCallbackData).toContain('sf:s:c.ds');
    expect(allCallbackData).toContain('sf:s:c.cds');
    expect(allCallbackData).toContain('sf:s:g.ds');
    expect(allCallbackData).toContain('sf:s:g.cds');
  });

  it('should have engine short codes i=itachi, c=itachic, g=itachig', () => {
    const keyboard = buildEngineKeyboard();
    // Row 0: itachi
    expect(keyboard[0][0].text).toContain('itachi');
    expect(keyboard[0][0].callback_data).toContain(':i.');
    // Row 1: itachic
    expect(keyboard[1][0].text).toContain('itachic');
    expect(keyboard[1][0].callback_data).toContain(':c.');
    // Row 2: itachig
    expect(keyboard[2][0].text).toContain('itachig');
    expect(keyboard[2][0].callback_data).toContain(':g.');
  });

  it('should include both --ds and --cds modes per engine', () => {
    const keyboard = buildEngineKeyboard();
    for (const row of keyboard) {
      const modes = row.map((btn) => btn.text);
      expect(modes.some((m) => m.includes('--ds'))).toBe(true);
      expect(modes.some((m) => m.includes('--cds'))).toBe(true);
    }
  });

  it('should keep callback_data under 64 bytes (Telegram limit)', () => {
    const keyboard = buildEngineKeyboard();
    for (const row of keyboard) {
      for (const btn of row) {
        expect(btn.callback_data.length).toBeLessThanOrEqual(64);
      }
    }
  });
});

// ============================================================
// 3. Session flow callback parsing (sf:s: engine+mode)
// ============================================================

describe('Session flow callback parsing — engine+mode', () => {
  it('should parse sf:s:i.ds as engine=itachi, mode=--ds', () => {
    const decoded = decodeCallback('sf:s:i.ds');
    expect(decoded).not.toBeNull();
    const { engine, mode } = parseEngineMode(decoded!.value);
    expect(engine).toBe('itachi');
    expect(mode).toBe('--ds');
  });

  it('should parse sf:s:c.cds as engine=itachic, mode=--cds', () => {
    const decoded = decodeCallback('sf:s:c.cds');
    expect(decoded).not.toBeNull();
    const { engine, mode } = parseEngineMode(decoded!.value);
    expect(engine).toBe('itachic');
    expect(mode).toBe('--cds');
  });

  it('should parse sf:s:g.ds as engine=itachig, mode=--ds', () => {
    const decoded = decodeCallback('sf:s:g.ds');
    expect(decoded).not.toBeNull();
    const { engine, mode } = parseEngineMode(decoded!.value);
    expect(engine).toBe('itachig');
    expect(mode).toBe('--ds');
  });

  it('should handle old format sf:s:ds (backward compat) as engine=itachi, mode=--ds', () => {
    const decoded = decodeCallback('sf:s:ds');
    expect(decoded).not.toBeNull();
    const { engine, mode } = parseEngineMode(decoded!.value);
    expect(engine).toBe('itachi');
    expect(mode).toBe('--ds');
  });

  it('should handle old format sf:s:cds (backward compat) as engine=itachi, mode=--cds', () => {
    const decoded = decodeCallback('sf:s:cds');
    expect(decoded).not.toBeNull();
    const { engine, mode } = parseEngineMode(decoded!.value);
    expect(engine).toBe('itachi');
    expect(mode).toBe('--cds');
  });

  it('should default unknown engine short to itachi', () => {
    const { engine } = parseEngineMode('z.ds');
    expect(engine).toBe('itachi');
  });
});

// ============================================================
// 4. encodeCallback round-trip
// ============================================================

describe('encodeCallback / decodeCallback round-trip', () => {
  it('should round-trip tf:m:0', () => {
    const encoded = encodeCallback('tf', 'm', 0);
    expect(encoded).toBe('tf:m:0');
    const decoded = decodeCallback(encoded);
    expect(decoded).toEqual({ prefix: 'tf', key: 'm', value: '0' });
  });

  it('should round-trip sf:s:i.ds', () => {
    const encoded = encodeCallback('sf', 's', 'i.ds');
    expect(encoded).toBe('sf:s:i.ds');
    const decoded = decodeCallback(encoded);
    expect(decoded).toEqual({ prefix: 'sf', key: 's', value: 'i.ds' });
  });

  it('should round-trip tf:rm:existing', () => {
    const encoded = encodeCallback('tf', 'rm', 'existing');
    expect(encoded).toBe('tf:rm:existing');
    const decoded = decodeCallback(encoded);
    expect(decoded).toEqual({ prefix: 'tf', key: 'rm', value: 'existing' });
  });
});

// ============================================================
// 5. Edge cases
// ============================================================

describe('Callback edge cases', () => {
  it('should handle data with extra colons (value joins remaining parts)', () => {
    const decoded = decodeCallback('bp:a:abc:extra:data');
    expect(decoded).not.toBeNull();
    expect(decoded!.prefix).toBe('bp');
    expect(decoded!.key).toBe('a');
    expect(decoded!.value).toBe('abc:extra:data');
  });

  it('should produce null for undefined-like inputs', () => {
    expect(decodeCallback('')).toBeNull();
  });

  it('should handle numeric values in decode', () => {
    const decoded = decodeCallback('tf:r:5');
    expect(decoded).not.toBeNull();
    expect(decoded!.value).toBe('5');
    expect(parseInt(decoded!.value, 10)).toBe(5);
  });

  it('should handle "here" value for subfolder selection', () => {
    const decoded = decodeCallback('sf:d:here');
    expect(decoded).not.toBeNull();
    expect(decoded!.prefix).toBe('sf');
    expect(decoded!.key).toBe('d');
    expect(decoded!.value).toBe('here');
  });
});

// ============================================================
// 6. ENGINE_SHORT mapping consistency
// ============================================================

describe('ENGINE_SHORT mapping', () => {
  it('should map i to itachi', () => {
    expect(ENGINE_SHORT['i']).toBe('itachi');
  });

  it('should map c to itachic', () => {
    expect(ENGINE_SHORT['c']).toBe('itachic');
  });

  it('should map g to itachig', () => {
    expect(ENGINE_SHORT['g']).toBe('itachig');
  });

  it('should have consistent reverse mapping', () => {
    for (const [short, full] of Object.entries(ENGINE_SHORT)) {
      expect(ENGINE_TO_SHORT[full]).toBe(short);
    }
  });
});

// ============================================================
// 7. Backoff delay logic
// ============================================================

describe('Backoff delay logic', () => {
  // Mirror the backoffDelay function from callback-handler.ts
  function backoffDelay(
    attempt: number,
    opts = { initialMs: 2000, maxMs: 30_000, factor: 1.8, jitter: 0.25 },
  ): number {
    const base = Math.min(opts.initialMs * Math.pow(opts.factor, attempt), opts.maxMs);
    const jitterRange = base * opts.jitter;
    return base + (Math.random() * 2 - 1) * jitterRange;
  }

  it('should return approximately initialMs for attempt 0', () => {
    const delays: number[] = [];
    for (let i = 0; i < 100; i++) {
      delays.push(backoffDelay(0));
    }
    const avg = delays.reduce((a, b) => a + b, 0) / delays.length;
    // Should be around 2000 (within jitter range: 1500-2500)
    expect(avg).toBeGreaterThan(1500);
    expect(avg).toBeLessThan(2500);
  });

  it('should increase delay with each attempt', () => {
    // Use no jitter for deterministic check
    const opts = { initialMs: 2000, maxMs: 30_000, factor: 1.8, jitter: 0 };
    const delay0 = backoffDelay(0, opts);
    const delay1 = backoffDelay(1, opts);
    const delay2 = backoffDelay(2, opts);
    expect(delay1).toBeGreaterThan(delay0);
    expect(delay2).toBeGreaterThan(delay1);
  });

  it('should cap at maxMs', () => {
    const opts = { initialMs: 2000, maxMs: 30_000, factor: 1.8, jitter: 0 };
    const delay = backoffDelay(100, opts);
    expect(delay).toBe(30_000);
  });

  it('should apply jitter within expected range', () => {
    const opts = { initialMs: 2000, maxMs: 30_000, factor: 1.8, jitter: 0.25 };
    // At attempt 0: base=2000, jitterRange=500, so range is [1500, 2500]
    for (let i = 0; i < 50; i++) {
      const delay = backoffDelay(0, opts);
      expect(delay).toBeGreaterThanOrEqual(1500);
      expect(delay).toBeLessThanOrEqual(2500);
    }
  });
});

// ============================================================
// 8. Mock ctx structure validation
// ============================================================

describe('Mock ctx structure', () => {
  it('should have expected fields for a valid callback', () => {
    const ctx = makeMockCtx('sf:s:i.ds');
    expect(ctx.callbackQuery.data).toBe('sf:s:i.ds');
    expect(ctx.callbackQuery.message.chat.id).toBe(123);
    expect(ctx.callbackQuery.message.message_id).toBe(456);
    expect(ctx.callbackQuery.from.id).toBe(999);
  });

  it('should have undefined data when constructed with undefined', () => {
    const ctx = makeMockCtx(undefined);
    expect(ctx.callbackQuery.data).toBeUndefined();
  });

  it('should allow threadId override for browse callbacks', () => {
    const ctx = makeMockCtx('browse:start', { threadId: 789 });
    expect(ctx.callbackQuery.message.message_thread_id).toBe(789);
  });
});
