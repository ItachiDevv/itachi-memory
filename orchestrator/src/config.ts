// Orchestrator v2 Configuration - validated 2026-02-10
import * as dotenv from 'dotenv';
import * as path from 'path';
import type { Config, Engine } from './types';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function required(key: string): string {
    const val = process.env[key];
    if (!val) {
        console.error(`ERROR: Missing required env var: ${key}`);
        process.exit(1);
    }
    return val;
}

function parseProjectPaths(raw: string): Record<string, string> {
    if (!raw || raw === '{}') return {};
    try {
        return JSON.parse(raw);
    } catch {
        console.error('ERROR: Invalid ITACHI_PROJECT_PATHS JSON');
        return {};
    }
}

const machineId = required('ITACHI_MACHINE_ID');

export const config: Config = {
    supabaseUrl: required('SUPABASE_URL'),
    supabaseKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    orchestratorId: process.env.ITACHI_ORCHESTRATOR_ID || 'default-orchestrator',
    maxConcurrent: parseInt(process.env.ITACHI_MAX_CONCURRENT || '2', 10),
    workspaceDir: process.env.ITACHI_WORKSPACE_DIR || path.join(require('os').homedir(), 'itachi-workspaces'),
    taskTimeoutMs: parseInt(process.env.ITACHI_TASK_TIMEOUT_MS || '600000', 10),
    defaultModel: process.env.ITACHI_DEFAULT_MODEL || 'opus',
    defaultBudget: parseFloat(process.env.ITACHI_DEFAULT_BUDGET || '5.00'),
    pollIntervalMs: parseInt(process.env.ITACHI_POLL_INTERVAL_MS || '5000', 10),
    projectPaths: parseProjectPaths(process.env.ITACHI_PROJECT_PATHS || '{}'),
    projectFilter: process.env.ITACHI_PROJECT_FILTER || undefined,
    apiUrl: process.env.ITACHI_API_URL || 'https://itachisbrainserver.online',
    syncPassphrase: process.env.ITACHI_SYNC_PASSPHRASE || '',
    defaultEngine: (process.env.ITACHI_DEFAULT_ENGINE || 'claude') as Engine,
    machineId,
    machineDisplayName: process.env.ITACHI_MACHINE_NAME || machineId,
};
