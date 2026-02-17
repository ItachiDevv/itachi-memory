// Orchestrator v2 - tested via Telegram
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import * as os from 'os';
import { config } from './config';
import { startRunner, stopRunner, getActiveCount, getActiveTasks } from './task-runner';
import { checkClaudeAuth, checkEngineAuth } from './session-manager';
import { getSupabase, fetchMachineConfig } from './supabase-client';

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
                engine_priority: config.enginePriority,
                health_url: `http://localhost:${HEALTH_PORT}`,
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

async function syncRemoteEngineConfig(): Promise<void> {
    try {
        const remote = await fetchMachineConfig(config.machineId);
        if (remote?.engine_priority?.length) {
            const current = config.enginePriority.join(',');
            const next = remote.engine_priority.join(',');
            if (current !== next) {
                console.log(`[config] Engine priority updated: ${current} → ${next}`);
                (config as any).enginePriority = remote.engine_priority;
            }
        }
    } catch {
        // Best-effort, non-blocking — don't log noise on every heartbeat
    }
}

function startHeartbeat(): void {
    heartbeatTimer = setInterval(() => {
        sendHeartbeat().catch(() => {});
        syncRemoteEngineConfig().catch(() => {});
        triggerRepoSync().catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

/** Verify Bearer token matches ITACHI_API_KEY */
function checkControlAuth(req: http.IncomingMessage): boolean {
    const apiKey = process.env.ITACHI_API_KEY;
    if (!apiKey) return true; // No key configured = no auth required
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    return token === apiKey;
}

/** Read the full request body as JSON */
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => {
            try { resolve(JSON.parse(body || '{}')); }
            catch { resolve({}); }
        });
    });
}

/** Allowlisted commands for /exec endpoint */
const EXEC_ALLOWLIST = [
    'git status', 'git log', 'git diff', 'git branch',
    'claude auth status', 'codex --version', 'gemini --version',
    'npm run build', 'node --version', 'npm --version',
    'uptime', 'df -h', 'free -h',
];

// Health + Control API server
const server = http.createServer(async (req, res) => {
    const url = req.url || '';
    const method = req.method || 'GET';

    // --- Public endpoints (no auth) ---
    if (url === '/health' && method === 'GET') {
        let queuedCount = 0;
        try {
            const sb = getSupabase();
            const { count } = await sb
                .from('itachi_tasks')
                .select('*', { count: 'exact', head: true })
                .eq('status', 'queued');
            queuedCount = count || 0;
        } catch { /* ignore */ }

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
        return;
    }

    if (url === '/status' && method === 'GET') {
        const engineStatuses: Record<string, { valid: boolean; error?: string }> = {};
        for (const engine of config.enginePriority) {
            engineStatuses[engine] = checkEngineAuth(engine);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            orchestrator_id: config.orchestratorId,
            machine_id: config.machineId,
            display_name: config.machineDisplayName,
            active_tasks: getActiveCount(),
            active_task_ids: getActiveTasks().map(id => id.substring(0, 8)),
            max_concurrent: config.maxConcurrent,
            engine_priority: config.enginePriority,
            engines: engineStatuses,
            uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
            memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            platform: process.platform,
            node_version: process.version,
        }));
        return;
    }

    // --- Authenticated endpoints ---
    if (!checkControlAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
    }

    if (url === '/pull' && method === 'POST') {
        try {
            const orchestratorDir = path.resolve(__dirname, '..');
            const output = execSync('git pull && npm run build', {
                cwd: orchestratorDir,
                encoding: 'utf8',
                timeout: 60_000,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, output: output.substring(0, 2000) }));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: msg.substring(0, 2000) }));
        }
        return;
    }

    if (url === '/restart' && method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Shutting down (restart externally)...' }));

        // Graceful shutdown — external process manager (systemd, pm2, etc.) handles restart.
        // The old spawn-child approach caused cascading process spawns.
        setTimeout(() => {
            console.log('[control] Restart requested, shutting down...');
            stopHeartbeat();
            stopRunner();
            server.close();
            process.exit(0);
        }, 2000);
        return;
    }

    if (url === '/exec' && method === 'POST') {
        const body = await readBody(req);
        const command = typeof body.command === 'string' ? body.command : '';

        // Check allowlist (command must start with one of the allowed prefixes)
        const allowed = EXEC_ALLOWLIST.some(prefix => command.startsWith(prefix));
        if (!allowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Command not in allowlist',
                allowlist: EXEC_ALLOWLIST,
            }));
            return;
        }

        try {
            const output = execSync(command, {
                encoding: 'utf8',
                timeout: 30_000,
                cwd: path.resolve(__dirname, '..'),
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, output: output.substring(0, 5000) }));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: msg.substring(0, 2000) }));
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
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
    console.log(`  Engines:     ${config.enginePriority.join(' → ')} (priority order)`);
    console.log('===========================================');

    // SAFETY: Warn if ANTHROPIC_API_KEY is in env — it causes Claude CLI to use
    // API billing instead of Max subscription, burning credits unnecessarily.
    if (process.env.ANTHROPIC_API_KEY) {
        console.warn('');
        console.warn('  WARNING: ANTHROPIC_API_KEY detected in environment!');
        console.warn('  Claude CLI will use API billing instead of Max subscription.');
        console.warn('  Remove ANTHROPIC_API_KEY from .env to use subscription auth.');
        console.warn('');
    }

    // Pre-check auth for all engines in priority order
    let anyValid = false;
    for (const engine of config.enginePriority) {
        const auth = checkEngineAuth(engine);
        if (auth.valid) {
            console.log(`  Auth:        ${engine} ✓`);
            anyValid = true;
        } else {
            console.warn(`  Auth:        ${engine} ✗ — ${auth.error}`);
        }
    }
    if (!anyValid) {
        console.error('');
        console.error('  *** ALL ENGINES FAILED AUTH ***');
        console.error('  Tasks will fail until at least one engine has valid auth.');
        console.error('');
    }

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
