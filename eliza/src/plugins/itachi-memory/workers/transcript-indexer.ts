import { type TaskWorker, type IAgentRuntime } from '@elizaos/core';
import { MemoryService } from '../services/memory-service.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CHUNK_SIZE = 5; // conversation turns per chunk
const MAX_MSG_LEN = 300;
const MAX_CHUNK_LEN = 1500;

interface TranscriptEntry {
  type: string;
  message?: { role?: string; content?: string | Array<{ text?: string }> };
}

function extractTextContent(entry: TranscriptEntry): string | null {
  const msg = entry.message;
  if (!msg?.content) return null;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(c => c.text || '').filter(Boolean).join(' ');
  }
  return null;
}

function deriveProjectName(encodedDir: string): string {
  // Encoded format: C--Users--foo--project → extract last segment
  const parts = encodedDir.split('--');
  return parts[parts.length - 1] || encodedDir;
}

function extractFilePaths(text: string): string[] {
  const patterns = [
    /(?:[A-Z]:\\|\/)[^\s"'`,;:]+\.\w{1,10}/g, // absolute paths
    /(?:src|lib|test|docs)\/[^\s"'`,;:]+\.\w{1,10}/g, // relative project paths
  ];
  const files = new Set<string>();
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) matches.forEach(m => files.add(m));
  }
  return [...files].slice(0, 10);
}

/**
 * Transcript indexer: runs every hour, indexes Claude Code session transcripts
 * from ~/.claude/projects/ into itachi_memories[session_transcript].
 */
export const transcriptIndexerWorker: TaskWorker = {
  name: 'ITACHI_TRANSCRIPT_INDEXER',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => {
    return fs.existsSync(CLAUDE_PROJECTS_DIR);
  },

  execute: async (runtime: IAgentRuntime): Promise<void> => {
    try {
      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!memoryService) {
        runtime.logger.warn('[transcript-indexer] MemoryService not available, skipping');
        return;
      }

      const supabase = memoryService.getSupabase();
      if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
        runtime.logger.info('[transcript-indexer] No .claude/projects directory, skipping');
        return;
      }

      const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'));

      let totalIndexed = 0;

      for (const projDir of projectDirs) {
        const projectPath = path.join(CLAUDE_PROJECTS_DIR, projDir.name);
        const projectName = deriveProjectName(projDir.name);

        // Find .jsonl files (skip subagents/ directory)
        const files = fs.readdirSync(projectPath, { withFileTypes: true })
          .filter(f => f.isFile() && f.name.endsWith('.jsonl'));

        for (const file of files) {
          const filePath = path.join(projectPath, file.name);
          const stats = fs.statSync(filePath);

          // Check offset table for previous progress
          const { data: offset } = await supabase
            .from('itachi_transcript_offsets')
            .select('lines_indexed, byte_offset')
            .eq('file_path', filePath)
            .single();

          const previousLines = offset?.lines_indexed ?? 0;
          const previousBytes = offset?.byte_offset ?? 0;

          // Skip if file hasn't grown
          if (stats.size <= previousBytes) continue;

          // Read entire file and parse lines
          const content = fs.readFileSync(filePath, 'utf-8');
          const allLines = content.split('\n').filter(l => l.trim());

          // Only process new lines
          const newLines = allLines.slice(previousLines);
          if (newLines.length < 2) continue;

          // Parse entries, extract user/assistant turns
          const turns: Array<{ role: string; text: string }> = [];
          for (const line of newLines) {
            try {
              const entry = JSON.parse(line) as TranscriptEntry;
              if (entry.type !== 'user' && entry.type !== 'assistant') continue;
              const text = extractTextContent(entry);
              if (!text || text.length < 10) continue;
              turns.push({ role: entry.type, text });
            } catch {
              // skip malformed lines
            }
          }

          // Chunk into groups of CHUNK_SIZE turns
          for (let i = 0; i < turns.length; i += CHUNK_SIZE) {
            const chunk = turns.slice(i, i + CHUNK_SIZE);
            if (chunk.length < 2) continue;

            // Build summary text
            let summaryParts = [`Project: ${projectName}`];
            let totalLen = summaryParts[0].length;

            for (const turn of chunk) {
              const truncated = turn.text.substring(0, MAX_MSG_LEN);
              const line = `${turn.role}: ${truncated}`;
              if (totalLen + line.length > MAX_CHUNK_LEN) break;
              summaryParts.push(line);
              totalLen += line.length;
            }

            const summaryText = summaryParts.join('\n');
            const allText = chunk.map(t => t.text).join(' ');
            const files = extractFilePaths(allText);

            try {
              await memoryService.storeMemory({
                project: projectName,
                category: 'session_transcript',
                content: summaryText,
                summary: `Session transcript: ${chunk.map(t => t.role).join(', ')} (${chunk.length} turns)`,
                files,
                metadata: {
                  source_file: filePath,
                  line_range: [previousLines + i, previousLines + i + chunk.length],
                },
              });
              totalIndexed++;
            } catch (chunkError) {
              runtime.logger.warn(`[transcript-indexer] Failed to store chunk at line ${previousLines + i}, continuing: ${chunkError}`);
            }
          }

          // Update offset
          await supabase
            .from('itachi_transcript_offsets')
            .upsert({
              file_path: filePath,
              byte_offset: stats.size,
              lines_indexed: allLines.length,
              last_indexed: new Date().toISOString(),
            });
        }
      }

      if (totalIndexed > 0) {
        runtime.logger.info(`[transcript-indexer] Indexed ${totalIndexed} transcript chunks`);
      }
    } catch (error) {
      runtime.logger.error('[transcript-indexer] Error:', error);
    }
  },
};

export async function registerTranscriptIndexerTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_TRANSCRIPT_INDEXER');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_TRANSCRIPT_INDEXER task already exists, skipping');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_TRANSCRIPT_INDEXER',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 60 * 60 * 1000, // 1 hour
      },
      tags: ['repeat'],
    });
    runtime.logger.info('Registered ITACHI_TRANSCRIPT_INDEXER repeating task (1hr)');
  } catch (error) {
    runtime.logger.error('Failed to register transcript indexer task:', error);
  }
}
