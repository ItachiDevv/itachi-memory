import type { IAgentRuntime } from '@elizaos/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface GitHubRepo {
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  private: boolean;
  default_branch: string;
  updated_at: string;
}

interface SyncResult {
  synced: number;
  total: number;
  errors: string[];
}

function getSupabase(runtime: IAgentRuntime): SupabaseClient {
  const url = String(runtime.getSetting('SUPABASE_URL') || '');
  const key = String(runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY') || runtime.getSetting('SUPABASE_KEY') || '');
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

/**
 * Fetch all GitHub repos for the authenticated user (paginated, max 1000).
 */
async function fetchAllGitHubRepos(token: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  let page = 1;
  const perPage = 100;

  while (page <= 10) { // max 1000 repos
    const res = await fetch(
      `https://api.github.com/user/repos?per_page=${perPage}&type=owner&sort=updated&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as GitHubRepo[];
    repos.push(...data);

    if (data.length < perPage) break;
    page++;
  }

  return repos;
}

/**
 * Sync all GitHub repos into project_registry.
 * Only updates repo_url and metadata — does NOT overwrite user-configured fields.
 */
export async function syncGitHubRepos(runtime: IAgentRuntime): Promise<SyncResult> {
  const token = String(runtime.getSetting('GITHUB_TOKEN') || '');
  if (!token) {
    return { synced: 0, total: 0, errors: ['GITHUB_TOKEN not configured'] };
  }

  const supabase = getSupabase(runtime);
  const repos = await fetchAllGitHubRepos(token);
  const errors: string[] = [];
  let synced = 0;

  for (const repo of repos) {
    try {
      const { error } = await supabase
        .from('project_registry')
        .upsert(
          {
            name: repo.name,
            repo_url: repo.clone_url,
            default_branch: repo.default_branch,
            active: true,
            metadata: {
              github: {
                full_name: repo.full_name,
                private: repo.private,
                default_branch: repo.default_branch,
                html_url: repo.html_url,
                synced_at: new Date().toISOString(),
              },
            },
          },
          {
            onConflict: 'name',
            // Only update these columns — leave user-configured fields intact
            ignoreDuplicates: false,
          }
        )
        // Use raw upsert — Supabase merges metadata jsonb at DB level
        .select('name')
        .single();

      if (error) {
        errors.push(`${repo.name}: ${error.message}`);
      } else {
        synced++;
      }
    } catch (err) {
      errors.push(`${repo.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { synced, total: repos.length, errors };
}

/**
 * Create a new private GitHub repo and register it in project_registry.
 */
export async function createGitHubRepo(
  runtime: IAgentRuntime,
  name: string
): Promise<{ repo_url: string; html_url: string } | null> {
  const token = String(runtime.getSetting('GITHUB_TOKEN') || '');
  if (!token) return null;

  // Create private repo
  const createRes = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      name,
      private: true,
      auto_init: true,
    }),
  });

  if (!createRes.ok) {
    const errBody = await createRes.text();
    throw new Error(`GitHub repo creation failed: ${createRes.status} ${errBody}`);
  }

  const created = (await createRes.json()) as GitHubRepo;

  // Register in project_registry
  const supabase = getSupabase(runtime);
  await supabase.from('project_registry').upsert(
    {
      name: created.name,
      repo_url: created.clone_url,
      default_branch: created.default_branch,
      active: true,
      metadata: {
        github: {
          full_name: created.full_name,
          private: created.private,
          default_branch: created.default_branch,
          html_url: created.html_url,
          synced_at: new Date().toISOString(),
        },
      },
    },
    { onConflict: 'name' }
  );

  return { repo_url: created.clone_url, html_url: created.html_url };
}
