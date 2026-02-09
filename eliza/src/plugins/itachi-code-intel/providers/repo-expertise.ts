import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import { CodeIntelService } from '../services/code-intel-service.js';

/**
 * Repo expertise provider: injects per-project expertise into agent context.
 * Position 9 — after session briefing.
 * Used when user mentions a project on Telegram or during chat interactions.
 */
export const repoExpertiseProvider: Provider = {
  name: 'repo-expertise',
  description: 'Project-specific expertise map built from session history',
  position: 9,

  get: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<string> => {
    try {
      const codeIntel = runtime.getService<CodeIntelService>('itachi-code-intel');
      if (!codeIntel) return '## Repo Expertise\nCode intelligence service unavailable. Do NOT guess about project architecture or patterns.';

      // Determine which project the user is asking about
      const messageText = message.content?.text || '';
      const project = extractProjectName(messageText, runtime);
      if (!project) return '## Repo Expertise\nNo project detected in this message. Do NOT invent project details — ask the user which project they mean.';

      const supabase = codeIntel.getSupabase();

      const { data } = await supabase
        .from('itachi_memories')
        .select('content')
        .eq('project', project)
        .eq('category', 'repo_expertise')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!data?.content) return `## Repo Expertise (${project})\nNo expertise data found for this project yet.`;

      return `## Project Expertise: ${project}\n${data.content}`;
    } catch {
      return '## Repo Expertise\nFailed to load expertise data. Do NOT make up project details.';
    }
  },
};

/**
 * Try to extract a project name from the message text.
 * Looks for known project names or metadata.
 */
function extractProjectName(text: string, runtime: IAgentRuntime): string | null {
  // Check message for explicit project reference
  const projectMatch = text.match(/\b(?:project|repo)\s+["']?(\w[\w-]*)["']?/i);
  if (projectMatch) return projectMatch[1];

  // Check for common project name patterns in the message
  const words = text.split(/\s+/).filter(w => w.length > 2 && w.length < 50);
  // We'd need to query known projects — skip for now to avoid overhead
  // The session-briefing provider already handles project-scoped context

  return null;
}
