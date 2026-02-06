import * as http from 'http';
import { config } from './config';
import { startRunner, stopRunner, getActiveCount, getActiveTasks } from './task-runner';
import { getSupabase } from './supabase-client';

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '3001', 10);
const startTime = Date.now();

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
    console.log(`  Max tasks:   ${config.maxConcurrent}`);
    console.log(`  Workspace:   ${config.workspaceDir}`);
    console.log(`  Timeout:     ${config.taskTimeoutMs / 1000}s`);
    console.log(`  Poll:        ${config.pollIntervalMs / 1000}s`);
    console.log(`  API:         ${config.apiUrl}`);
    console.log(`  Projects:    ${Object.keys(config.projectPaths).join(', ') || '(none configured)'}`);
    console.log('===========================================');
    console.log('');

    // Start health server
    server.listen(HEALTH_PORT, () => {
        console.log(`[health] Listening on http://localhost:${HEALTH_PORT}/health`);
    });

    // Start task runner
    await startRunner();

    console.log('[main] Orchestrator running. Press Ctrl+C to stop.');
}

// Graceful shutdown
function shutdown(): void {
    console.log('\n[main] Shutting down...');
    stopRunner();
    server.close();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
    console.error('[main] Fatal error:', err);
    process.exit(1);
});
