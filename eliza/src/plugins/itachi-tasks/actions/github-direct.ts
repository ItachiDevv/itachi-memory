import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';
import { stripBotMention } from '../utils/telegram.js';

/**
 * Direct GitHub API queries without task creation.
 * Handles /gh, /prs, /branches, /issues and NL queries about PRs/issues/branches.
 */

interface GitHubRepo {
  name: string;
  github_url?: string;
  [key: string]: unknown;
}

function extractOwnerRepo(repo: GitHubRepo): { owner: string; repo: string } | null {
  const url = repo.github_url;
  if (!url) return null;
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

async function ghFetch(path: string, token: string): Promise<any> {
  const resp = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'itachi-bot',
    },
  });
  if (!resp.ok) {
    throw new Error(`GitHub API ${resp.status}: ${resp.statusText}`);
  }
  return resp.json();
}

type QueryType = 'prs' | 'issues' | 'branches' | 'repo-info';

function detectQueryType(text: string): QueryType {
  const lower = text.toLowerCase();
  if (/\b(pr|pull\s*request|merge|merged)\b/.test(lower)) return 'prs';
  if (/\b(issue|bug|feature\s*request|ticket)\b/.test(lower)) return 'issues';
  if (/\b(branch|branches)\b/.test(lower)) return 'branches';
  return 'repo-info';
}

function resolveRepoName(text: string, repos: GitHubRepo[]): GitHubRepo | null {
  const lower = text.toLowerCase();
  // Check each repo name (case-insensitive)
  for (const repo of repos) {
    const pattern = new RegExp(`\\b${repo.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(lower)) return repo;
  }
  // Default to first repo if only one exists
  if (repos.length === 1) return repos[0];
  return null;
}

async function handlePRs(owner: string, repo: string, token: string, state: string = 'open'): Promise<string> {
  const prs = await ghFetch(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=15&sort=updated&direction=desc`, token);
  if (!Array.isArray(prs) || prs.length === 0) {
    return `No ${state} PRs in ${owner}/${repo}.`;
  }
  const lines = prs.map((pr: any, i: number) => {
    const labels = pr.labels?.map((l: any) => l.name).join(', ') || '';
    const labelStr = labels ? ` [${labels}]` : '';
    return `${i + 1}. #${pr.number} ${pr.title}${labelStr}\n   by ${pr.user?.login || '?'} | ${pr.state} | updated ${new Date(pr.updated_at).toLocaleDateString()}`;
  });
  return `${state.charAt(0).toUpperCase() + state.slice(1)} PRs in ${owner}/${repo} (${prs.length}):\n\n${lines.join('\n')}`;
}

async function handleIssues(owner: string, repo: string, token: string, state: string = 'open'): Promise<string> {
  const issues = await ghFetch(`/repos/${owner}/${repo}/issues?state=${state}&per_page=15&sort=updated&direction=desc`, token);
  if (!Array.isArray(issues) || issues.length === 0) {
    return `No ${state} issues in ${owner}/${repo}.`;
  }
  // Filter out PRs (GitHub API returns PRs in issues endpoint)
  const filtered = issues.filter((i: any) => !i.pull_request);
  if (filtered.length === 0) {
    return `No ${state} issues (only PRs) in ${owner}/${repo}.`;
  }
  const lines = filtered.map((issue: any, i: number) => {
    const labels = issue.labels?.map((l: any) => l.name).join(', ') || '';
    const labelStr = labels ? ` [${labels}]` : '';
    return `${i + 1}. #${issue.number} ${issue.title}${labelStr}\n   by ${issue.user?.login || '?'} | updated ${new Date(issue.updated_at).toLocaleDateString()}`;
  });
  return `${state.charAt(0).toUpperCase() + state.slice(1)} issues in ${owner}/${repo} (${filtered.length}):\n\n${lines.join('\n')}`;
}

async function handleBranches(owner: string, repo: string, token: string): Promise<string> {
  const branches = await ghFetch(`/repos/${owner}/${repo}/branches?per_page=30`, token);
  if (!Array.isArray(branches) || branches.length === 0) {
    return `No branches found in ${owner}/${repo}.`;
  }
  const lines = branches.map((b: any, i: number) => {
    const prot = b.protected ? ' (protected)' : '';
    return `${i + 1}. ${b.name}${prot}`;
  });
  return `Branches in ${owner}/${repo} (${branches.length}):\n\n${lines.join('\n')}`;
}

async function handleRepoInfo(owner: string, repo: string, token: string): Promise<string> {
  const info = await ghFetch(`/repos/${owner}/${repo}`, token);
  const openPrs = await ghFetch(`/repos/${owner}/${repo}/pulls?state=open&per_page=1`, token);
  const openIssues = info.open_issues_count || 0;
  const prCount = Array.isArray(openPrs) ? openPrs.length : 0;

  return `${owner}/${repo}\n\n` +
    `Description: ${info.description || '(none)'}\n` +
    `Default branch: ${info.default_branch}\n` +
    `Stars: ${info.stargazers_count} | Forks: ${info.forks_count}\n` +
    `Open issues: ${openIssues} | Open PRs: ${prCount}+\n` +
    `Last push: ${new Date(info.pushed_at).toLocaleDateString()}\n` +
    `URL: ${info.html_url}`;
}

export const githubDirectAction: Action = {
  name: 'GITHUB_DIRECT',
  description: 'Query GitHub directly without creating a task. Handles /gh, /prs, /branches, /issues and NL questions about PRs, issues, branches.',
  similes: [
    'github query', 'list prs', 'show pull requests', 'open issues',
    'check branches', 'repo status', 'what prs are open', 'any open issues',
  ],
  examples: [
    [
      { name: 'user', content: { text: '/prs itachi-memory' } },
      { name: 'Itachi', content: { text: 'Open PRs in ItachiDevv/itachi-memory (2):\n\n1. #6 Fix topic manager...' } },
    ],
    [
      { name: 'user', content: { text: 'what PRs are open on itachi-memory?' } },
      { name: 'Itachi', content: { text: 'Open PRs in ItachiDevv/itachi-memory (1):\n\n1. #7 Add interactive sessions...' } },
    ],
    [
      { name: 'user', content: { text: '/gh branches itachi-memory' } },
      { name: 'Itachi', content: { text: 'Branches in ItachiDevv/itachi-memory (5):\n\n1. master (protected)\n2. feature/sessions...' } },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = stripBotMention(message.content?.text || '');
    // Explicit slash commands
    if (/^\/(gh|prs|branches|issues)\b/.test(text)) return true;
    // NL: mentions PR/branch/issue + query words
    const lower = text.toLowerCase();
    const mentionsGH = /\b(pr|pull\s*request|branch|branches|issue|issues|merge|merged|ci|checks?|pipeline)\b/.test(lower);
    const isQuery = /\b(what|show|list|check|any|open|status|how many|closed|merged)\b/.test(lower);
    if (mentionsGH && isQuery) return true;
    return false;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const token = String(runtime.getSetting('GITHUB_TOKEN') || process.env.GITHUB_TOKEN || '');
      if (!token) {
        if (callback) await callback({ text: 'GITHUB_TOKEN not configured. Set it in env to use GitHub queries.' });
        return { success: false, error: 'No GitHub token' };
      }

      const taskService = runtime.getService<TaskService>('itachi-tasks');
      if (!taskService) {
        if (callback) await callback({ text: 'Task service not available.' });
        return { success: false, error: 'Task service not available' };
      }

      const text = stripBotMention(message.content?.text || '');
      const repos = await taskService.getMergedRepos();

      // Parse slash command format: /prs <repo> or /gh <type> <repo>
      let queryType: QueryType;
      let repoRef: string = '';
      let state = 'open';

      const slashPrs = text.match(/^\/prs(?:\s+(.+))?$/i);
      const slashIssues = text.match(/^\/issues(?:\s+(.+))?$/i);
      const slashBranches = text.match(/^\/branches(?:\s+(.+))?$/i);
      const slashGh = text.match(/^\/gh\s+(prs?|issues?|branches?|info|status)(?:\s+(.+))?$/i);

      if (slashPrs) {
        queryType = 'prs';
        repoRef = slashPrs[1] || '';
      } else if (slashIssues) {
        queryType = 'issues';
        repoRef = slashIssues[1] || '';
      } else if (slashBranches) {
        queryType = 'branches';
        repoRef = slashBranches[1] || '';
      } else if (slashGh) {
        const typeStr = slashGh[1].toLowerCase();
        if (typeStr.startsWith('pr') || typeStr === 'merge') queryType = 'prs';
        else if (typeStr.startsWith('issue')) queryType = 'issues';
        else if (typeStr.startsWith('branch')) queryType = 'branches';
        else queryType = 'repo-info';
        repoRef = slashGh[2] || '';
      } else {
        // NL detection
        queryType = detectQueryType(text);
        // Check for state in NL
        if (/\b(closed|merged)\b/i.test(text)) state = 'closed';
      }

      // Resolve repo
      const repo = repoRef
        ? resolveRepoName(repoRef, repos)
        : resolveRepoName(text, repos);

      if (!repo) {
        const repoNames = repos.map((r: GitHubRepo) => r.name).join(', ');
        if (callback) await callback({
          text: `Which repo? Available: ${repoNames || '(none)'}\n\nUsage: /prs <repo> or /gh prs <repo>`,
        });
        return { success: false, error: 'No repo identified' };
      }

      const ownerRepo = extractOwnerRepo(repo);
      if (!ownerRepo) {
        if (callback) await callback({ text: `No GitHub URL configured for "${repo.name}". Run /sync_repos first.` });
        return { success: false, error: 'No GitHub URL for repo' };
      }

      // Fetch data
      let result: string;
      switch (queryType) {
        case 'prs':
          result = await handlePRs(ownerRepo.owner, ownerRepo.repo, token, state);
          break;
        case 'issues':
          result = await handleIssues(ownerRepo.owner, ownerRepo.repo, token, state);
          break;
        case 'branches':
          result = await handleBranches(ownerRepo.owner, ownerRepo.repo, token);
          break;
        case 'repo-info':
          result = await handleRepoInfo(ownerRepo.owner, ownerRepo.repo, token);
          break;
      }

      if (callback) await callback({ text: result });
      return { success: true, data: { queryType, repo: repo.name, state } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (callback) await callback({ text: `GitHub error: ${msg}` });
      return { success: false, error: msg };
    }
  },
};
