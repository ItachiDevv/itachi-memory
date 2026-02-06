import { Service, type IAgentRuntime } from '@elizaos/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface SyncFile {
  id: string;
  repo_name: string;
  file_path: string;
  encrypted_data: string;
  salt: string;
  content_hash: string;
  version: number;
  updated_by: string;
  updated_at: string;
  created_at: string;
}

export class SyncService extends Service {
  static serviceType = 'itachi-sync';
  capabilityDescription = 'Encrypted file sync across machines via Supabase';

  private supabase: SupabaseClient;
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
    const url = runtime.getSetting('SUPABASE_URL');
    const key = runtime.getSetting('SUPABASE_KEY');
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_KEY are required for SyncService');
    }
    this.supabase = createClient(url, key);
  }

  static async start(runtime: IAgentRuntime): Promise<SyncService> {
    const service = new SyncService(runtime);
    runtime.logger.info('SyncService started');
    return service;
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('SyncService stopped');
  }

  async pushFile(params: {
    repo_name: string;
    file_path: string;
    encrypted_data: string;
    salt: string;
    content_hash: string;
    updated_by: string;
  }): Promise<{ version: number; file_path: string }> {
    const { data, error } = await this.supabase.rpc('upsert_sync_file', {
      p_repo_name: params.repo_name,
      p_file_path: params.file_path,
      p_encrypted_data: params.encrypted_data,
      p_salt: params.salt,
      p_content_hash: params.content_hash,
      p_updated_by: params.updated_by,
    });

    if (error) throw error;
    return { version: data.version, file_path: data.file_path };
  }

  async pullFile(repo: string, filePath: string): Promise<SyncFile | null> {
    const { data, error } = await this.supabase
      .from('sync_files')
      .select('*')
      .eq('repo_name', repo)
      .eq('file_path', filePath)
      .single();

    if (error || !data) return null;
    return data as SyncFile;
  }

  async listFiles(repo: string): Promise<Array<{
    file_path: string;
    content_hash: string;
    version: number;
    updated_by: string;
    updated_at: string;
  }>> {
    const { data, error } = await this.supabase
      .from('sync_files')
      .select('file_path, content_hash, version, updated_by, updated_at')
      .eq('repo_name', repo)
      .order('file_path');

    if (error) throw error;
    return data || [];
  }

  getSupabase(): SupabaseClient {
    return this.supabase;
  }
}
