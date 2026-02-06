import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import { CodeIntelService } from '../services/code-intel-service.js';

/**
 * Session briefing provider: injects recent session context into agent.
 * Position 8 — after memory providers but before task providers.
 */
export const sessionBriefingProvider: Provider = {
  name: 'session-briefing',
  description: 'Recent session activity and hot files for the current project',
  position: 8,

  get: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<string> => {
    try {
      const codeIntel = runtime.getService<CodeIntelService>('itachi-code-intel');
      if (!codeIntel) return '';

      // Try to determine project from message metadata or recent context
      const project = (message.metadata as Record<string, unknown>)?.project as string;
      if (!project) return '';

      const supabase = codeIntel.getSupabase();

      // Get recent sessions
      const { data: sessions } = await supabase
        .from('session_summaries')
        .select('summary, files_changed, created_at')
        .eq('project', project)
        .order('created_at', { ascending: false })
        .limit(3);

      if (!sessions || sessions.length === 0) return '';

      const hotFiles = await codeIntel.getHotFiles(project, 7);

      const lines: string[] = ['## Recent Sessions'];
      for (const s of sessions) {
        const ago = timeAgo(new Date(s.created_at));
        lines.push(`- ${ago}: ${s.summary || '(no summary)'}`);
        if (s.files_changed?.length > 0) {
          lines.push(`  Files: ${s.files_changed.slice(0, 5).join(', ')}`);
        }
      }

      if (hotFiles.length > 0) {
        lines.push('## Hot Files (last 7d)');
        for (const f of hotFiles.slice(0, 8)) {
          lines.push(`- ${f.path} (${f.editCount} edits)`);
        }
      }

      return lines.join('\n');
    } catch {
      return '';
    }
  },
};

function timeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
