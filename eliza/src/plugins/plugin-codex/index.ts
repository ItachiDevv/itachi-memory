import { type Plugin, type IAgentRuntime, ModelType, logger } from '@elizaos/core';
import { execFile } from 'node:child_process';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Itachi Codex Plugin — routes text generation through the Codex CLI
 * using a ChatGPT/Codex subscription (OAuth) instead of API keys.
 *
 * TEXT_SMALL, OBJECT_SMALL, TEXT_LARGE: Routed to Codex when ITACHI_CODEX_ENABLED=true.
 * Priority 20 beats Gemini (10) and Anthropic (0).
 *
 * When disabled, the `models` getter returns {} so lower-priority providers handle everything.
 */

let codexEnabled = false;

const getCmd = () => process.env.ITACHI_CODEX_CMD ?? 'codex';
const getModel = () => process.env.ITACHI_CODEX_MODEL ?? '';
const getTimeout = () => Number(process.env.ITACHI_CODEX_TIMEOUT_MS ?? 60000);

/**
 * Spawn `codex exec` with the prompt piped via stdin and output captured via -o tempfile.
 */
async function callCodex(prompt: string): Promise<string> {
  const cmd = getCmd();
  const model = getModel();
  const timeout = getTimeout();
  const outFile = join(tmpdir(), `codex-out-${randomUUID()}.txt`);

  // Ensure the output file exists so codex can write to it
  await writeFile(outFile, '', 'utf-8');

  const args = ['exec', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '-o', outFile];
  if (model) {
    args.push('-m', model);
  }
  args.push('-'); // read prompt from stdin

  return new Promise<string>((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, async (err) => {
      try {
        if (err) {
          // Try to read partial output even on error
          try {
            const partial = await readFile(outFile, 'utf-8');
            if (partial.trim()) {
              logger.warn(`[Codex] Process errored but got partial output (${partial.length} chars)`);
              resolve(partial.trim());
              return;
            }
          } catch { /* no partial output */ }
          reject(new Error(`Codex exec failed: ${err.message}`));
          return;
        }

        const result = await readFile(outFile, 'utf-8');
        if (!result.trim()) {
          reject(new Error('Codex returned empty output'));
          return;
        }
        resolve(result.trim());
      } finally {
        unlink(outFile).catch(() => {});
      }
    });

    // Pipe prompt via stdin
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

async function handleText(
  _runtime: IAgentRuntime,
  modelType: string,
  { prompt }: { prompt: string },
): Promise<string> {
  logger.log(`[Codex] ${modelType} → ${getModel() || '(default)'}`);
  return callCodex(prompt);
}

export const itachiCodexPlugin: Plugin = {
  name: 'itachi-codex',
  description: 'Routes TEXT_SMALL/OBJECT_SMALL/TEXT_LARGE to Codex CLI (subscription auth)',
  priority: 20,

  config: {
    ITACHI_CODEX_ENABLED: process.env.ITACHI_CODEX_ENABLED,
    ITACHI_CODEX_CMD: process.env.ITACHI_CODEX_CMD,
    ITACHI_CODEX_MODEL: process.env.ITACHI_CODEX_MODEL,
    ITACHI_CODEX_TIMEOUT_MS: process.env.ITACHI_CODEX_TIMEOUT_MS,
  },

  async init() {
    const enabled = (process.env.ITACHI_CODEX_ENABLED ?? '').toLowerCase();
    if (enabled !== 'true' && enabled !== '1') {
      logger.info('[Codex] ITACHI_CODEX_ENABLED not set — Codex plugin disabled');
      codexEnabled = false;
      return;
    }

    // Verify codex CLI is available and authenticated
    const cmd = getCmd();
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(cmd, ['login', 'status'], { timeout: 10000 }, (err, stdout) => {
          if (err) {
            reject(new Error(`${cmd} login status failed: ${err.message}`));
            return;
          }
          logger.info(`[Codex] Auth check: ${stdout.trim()}`);
          resolve();
        });
      });
      codexEnabled = true;
      logger.info(`[Codex] Plugin active — model: ${getModel() || '(default)'}, timeout: ${getTimeout()}ms`);
    } catch (err) {
      logger.error(`[Codex] Auth check failed — plugin disabled: ${err instanceof Error ? err.message : String(err)}`);
      codexEnabled = false;
    }
  },

  get models() {
    if (!codexEnabled) {
      return {};
    }

    return {
      [ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params: Record<string, unknown>) => {
        try {
          return await handleText(runtime, 'TEXT_SMALL', params as { prompt: string });
        } catch (err) {
          logger.error(`[Codex] TEXT_SMALL error: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      },
      [ModelType.OBJECT_SMALL]: async (runtime: IAgentRuntime, params: Record<string, unknown>) => {
        try {
          return await handleText(runtime, 'OBJECT_SMALL', params as { prompt: string });
        } catch (err) {
          logger.error(`[Codex] OBJECT_SMALL error: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      },
      [ModelType.TEXT_LARGE]: async (runtime: IAgentRuntime, params: Record<string, unknown>) => {
        try {
          return await handleText(runtime, 'TEXT_LARGE', params as { prompt: string });
        } catch (err) {
          logger.error(`[Codex] TEXT_LARGE error: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      },
    };
  },
};
