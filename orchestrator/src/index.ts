import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { startRunner, stopRunner, getActiveCount, getActiveTasks } from './task-runner';
import { getSupabase } from './supabase-client';

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '3001', 10);
const HEARTBEAT_INTERVAL_MS = 30_000;
const REPO_SYNC_INTERVAL_MS = 86_400_000; // 24 hours
const startTime = Date.now();
let heartbeatTimer: NodeJS.Timeout | null = null;
let lastRepoSyncAt = 0;

function getApiHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.ITACHI_API_KEY) headers['Authorization'] = `Bearer ${process.env.ITACHI_API_KEY}`;
    return headers;
}

/**
 * Auto-detect local projects from:
 * 1. projectPaths config (explicitly mapped projects)
 * 2. Scanning workspace dir for existing cloned repos
 */
function detectLocalProjects(): string[] {
    const projects = new Set<string>();

    // From projectPaths (e.g. { "itachi-memory": "/home/user/itachi-memory" })
    for (const project of Object.keys(config.projectPaths)) {
        if (fs.existsSync(config.projectPaths[project])) {
            projects.add(project);
        }
    }

    // Scan workspace dir for existing repos
    try {
        if (fs.existsSync(config.workspaceDir)) {
            for (const entry of fs.readdirSync(config.workspaceDir)) {
                const fullPath = path.join(config.workspaceDir, entry);
                if (fs.statSync(fullPath).isDirectory() && fs.existsSync(path.join(fullPath, '.git'))) {
                    // Extract project name (workspace dirs are "projectname-taskid")
                    const projectName = entry.replace(/-[a-f0-9]{8}$/, '');
                    if (projectName) projects.add(projectName);
                }
            }
        }
    } catch {
        // Workspace dir doesn't exist yet, that's fine
    }

    return [...projects];
}

async function registerMachine(): Promise<void> {
    try {
        const localProjects = detectLocalProjects();
        const response = await fetch(`${config.apiUrl}/api/machines/register`, {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify({
                machine_id: config.machineId,
                display_name: config.machineDisplayName,
                projects: localProjects,
                max_concurrent: config.maxConcurrent,
                os: process.platform,
            }),
        });
        if (!response.ok) {
            console.warn(`[machine] Registration failed: ${response.status} ${response.statusText}`);
        } else {
            console.log(`[machine] Registered as "${config.machineId}"`);
        }
    } catch (err) {
        console.warn(`[machine] Registration error (will retry via heartbeat):`, err instanceof Error ? err.message : err);
    }
}

async function sendHeartbeat(activeTasks?: number): Promise<void> {
    try {
        const response = await fetch(`${config.apiUrl}/api/machines/heartbeat`, {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify({
                machine_id: config.machineId,
                active_tasks: activeTasks ?? getActiveCount(),
            }),
        });
        if (!response.ok) {
            console.warn(`[machine] Heartbeat failed: ${response.status}`);
        }
    } catch (err) {
        console.warn(`[machine] Heartbeat error:`, err instanceof Error ? err.message : err);
    }
}

async function triggerRepoSync(): Promise<void> {
    const now = Date.now();
    if (now - lastRepoSyncAt < REPO_SYNC_INTERVAL_MS) return;
    lastRepoSyncAt = now;

    try {
        const res = await fetch(`${config.apiUrl}/api/repos/sync`, {
            method: 'POST',
            headers: getApiHeaders(),
        });
        if (res.ok) {
            const data = (await res.json()) as { synced?: number; total?: number };
            console.log(`[sync] GitHub repo sync: ${data.synced}/${data.total} repos`);
        }
    } catch {
        // Best-effort, non-blocking
    }
}

function startHeartbeat(): void {
    heartbeatTimer = setInterval(() => {
        sendHeartbeat().catch(() => {});
        triggerRepoSync().catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

// Health endpoint
const server = http.createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
        let queuedCount = 0;
        try {
            const sb = getSupabase();
            const { count } = await sb
                .from('itachi_tasks')
                .select('*', { count: 'exact', head: true })
                .eq('status', 'queued');
            queuedCount = count || 0;
        } catch {
            // ignore
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            orchestrator_id: config.orchestratorId,
            machine_id: config.machineId,
            active_tasks: getActiveCount(),
            active_task_ids: getActiveTasks().map(id => id.substring(0, 8)),
            queued_tasks: queuedCount,
            max_concurrent: config.maxConcurrent,
            uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        }));
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

async function main(): Promise<void> {
    console.log('');
    console.log('===========================================');
    console.log('  Itachi Orchestrator Starting');
    console.log('===========================================');
    console.log(`  ID:          ${config.orchestratorId}`);
    console.log(`  Machine:     ${config.machineId} (${config.machineDisplayName})`);
    console.log(`  Max tasks:   ${config.maxConcurrent}`);
    console.log(`  Workspace:   ${config.workspaceDir}`);
    console.log(`  Timeout:     ${config.taskTimeoutMs / 1000}s`);
    console.log(`  Poll:        ${config.pollIntervalMs / 1000}s`);
    console.log(`  API:         ${config.apiUrl}`);
    const detectedProjects = detectLocalProjects();
    console.log(`  Projects:    ${detectedProjects.join(', ') || '(auto-detect on register)'}`);
    console.log(`  Engine:      ${config.defaultEngine}`);
    console.log('===========================================');
    console.log('');

    // Register machine with ElizaOS
    await registerMachine();

    // Start health server
    server.listen(HEALTH_PORT, () => {
        console.log(`[health] Listening on http://localhost:${HEALTH_PORT}/health`);
    });

    // Start task runner
    await startRunner();

    // Start heartbeat (every 30s)
    startHeartbeat();

    console.log('[main] Orchestrator running. Press Ctrl+C to stop.');
}

// Graceful shutdown
async function shutdown(): Promise<void> {
    console.log('\n[main] Shutting down...');
    stopHeartbeat();
    stopRunner();

    // Send final heartbeat with 0 active tasks to mark offline
    await sendHeartbeat(0);

    server.close();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
    console.error('[main] Fatal error:', err);
    process.exit(1);
});
