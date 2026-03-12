import type { Route, IAgentRuntime } from '@elizaos/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _supabase: SupabaseClient | null = null;

function getSupabase(runtime: IAgentRuntime): SupabaseClient {
  if (!_supabase) {
    const url = runtime.getSetting('SUPABASE_URL') as string;
    const key = runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY') as string;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
    _supabase = createClient(url, key);
  }
  return _supabase;
}

export const syncRoutes: Route[] = [
  // POST /api/sync/push — push an encrypted file to Supabase
  {
    type: 'POST',
    path: '/api/sync/push',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        const supabase = getSupabase(rt);
        const { repo_name, file_path, encrypted_data, salt, content_hash, updated_by } = req.body as Record<string, string>;

        if (!repo_name || !file_path || !encrypted_data || !salt || !content_hash || !updated_by) {
          res.status(400).json({ error: 'Missing required fields: repo_name, file_path, encrypted_data, salt, content_hash, updated_by' });
          return;
        }

        const { data, error } = await supabase.rpc('upsert_sync_file', {
          p_repo_name: repo_name,
          p_file_path: file_path,
          p_encrypted_data: encrypted_data,
          p_salt: salt,
          p_content_hash: content_hash,
          p_updated_by: updated_by,
        });

        if (error) throw error;

        rt.logger.info(`[sync] Pushed ${repo_name}/${file_path} v${data.version} by ${updated_by}`);
        res.json({ success: true, version: data.version, file_path: data.file_path });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  },

  // GET /api/sync/pull/* — pull encrypted file data
  // URL format: /api/sync/pull/<repo>/<file_path...>
  // ElizaOS wildcard routing does literal prefix match, so we parse repo/file from the URL
  {
    type: 'GET',
    path: '/api/sync/pull/*',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        const supabase = getSupabase(rt);

        // Extract repo and file_path from URL: /api/sync/pull/<repo>/<file_path>
        const pullPrefix = '/api/sync/pull/';
        const reqPath = (req as any).path || (req as any).url || '';
        const afterPrefix = reqPath.indexOf(pullPrefix) !== -1
          ? reqPath.substring(reqPath.indexOf(pullPrefix) + pullPrefix.length)
          : '';
        const slashIdx = afterPrefix.indexOf('/');
        if (slashIdx === -1 || !afterPrefix) {
          res.status(400).json({ error: 'URL format: /api/sync/pull/:repo/:file_path' });
          return;
        }
        const repo = decodeURIComponent(afterPrefix.substring(0, slashIdx));
        const filePath = decodeURIComponent(afterPrefix.substring(slashIdx + 1));

        const { data, error } = await supabase
          .from('sync_files')
          .select('*')
          .eq('repo_name', repo)
          .eq('file_path', filePath)
          .single();

        if (error || !data) {
          res.status(404).json({ error: 'File not found' });
          return;
        }

        res.json(data);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  },

  // GET /api/sync/list/:repo — list synced files for a repo
  {
    type: 'GET',
    path: '/api/sync/list/:repo',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        const supabase = getSupabase(rt);
        const repo = req.params!.repo;

        const { data, error } = await supabase
          .from('sync_files')
          .select('file_path, content_hash, version, updated_by, updated_at')
          .eq('repo_name', repo)
          .order('file_path');

        if (error) throw error;

        res.json({ repo_name: repo, files: data || [] });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  },
];
