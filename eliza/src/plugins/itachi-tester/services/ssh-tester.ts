import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TestResult } from '../types.js';

const execFileAsync = promisify(execFile);

interface SSHHost {
  name: string;
  user: string;
  address: string;
  isWindows?: boolean;
}

const SSH_HOSTS: SSHHost[] = [
  { name: 'mac', user: 'mac', address: '100.103.124.46' },
  { name: 'surface-win', user: 'surface-win', address: '100.106.148.100', isWindows: true },
  { name: 'hoodie', user: 'hoodie', address: '100.105.111.11' },
];

const SSH_KEY = '/root/.ssh/id_ed25519';
const CONNECT_TIMEOUT = 10;

async function sshRun(host: SSHHost, command: string): Promise<{ stdout: string; stderr: string; durationMs: number }> {
  const start = Date.now();
  const { stdout, stderr } = await execFileAsync('ssh', [
    '-i', SSH_KEY,
    '-o', `ConnectTimeout=${CONNECT_TIMEOUT}`,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    `${host.user}@${host.address}`,
    command,
  ], { timeout: (CONNECT_TIMEOUT + 15) * 1000 });
  return { stdout, stderr, durationMs: Date.now() - start };
}

async function testHost(host: SSHHost): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Reachability + node version
  {
    const start = Date.now();
    try {
      const cmd = host.isWindows
        ? 'powershell -Command "echo reachable; node --version"'
        : 'echo reachable && node --version';

      const { stdout, durationMs } = await sshRun(host, cmd);
      const reachable = stdout.includes('reachable');
      const nodeMatch = stdout.match(/v[\d.]+/);
      results.push({
        name: `${host.name}-reachable`,
        status: reachable ? 'pass' : 'fail',
        durationMs,
        message: reachable
          ? `Reachable, Node ${nodeMatch?.[0] || 'unknown'}`
          : 'Could not confirm reachability from output',
        detail: stdout.substring(0, 300),
        metadata: { node_version: nodeMatch?.[0] || null, latency_ms: durationMs },
      });
    } catch (err) {
      results.push({
        name: `${host.name}-reachable`,
        status: 'fail',
        durationMs: Date.now() - start,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Orchestrator process check
  {
    const start = Date.now();
    try {
      const cmd = host.isWindows
        ? 'powershell -Command "Get-Process | Where-Object { $_.ProcessName -like \'*node*\' } | Select-Object -First 1 ProcessName,Id"'
        : 'pgrep -f "node.*orchestrator\\|node.*eliza\\|node.*index" | head -1 && ps aux | grep -E "node.*(orchestrator|eliza|index)" | grep -v grep | head -1';

      const { stdout, durationMs } = await sshRun(host, cmd);
      const running = stdout.trim().length > 0;
      results.push({
        name: `${host.name}-orchestrator`,
        status: running ? 'pass' : 'fail',
        durationMs,
        message: running ? 'Orchestrator process found' : 'No orchestrator process detected',
        detail: stdout.trim().substring(0, 200),
        metadata: { orchestrator_running: running },
      });
    } catch (err) {
      results.push({
        name: `${host.name}-orchestrator`,
        status: 'fail',
        durationMs: Date.now() - start,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

export async function runSSHTests(): Promise<TestResult[]> {
  const allResults: TestResult[] = [];

  for (const host of SSH_HOSTS) {
    try {
      const hostResults = await testHost(host);
      allResults.push(...hostResults);
    } catch (err) {
      allResults.push({
        name: `${host.name}-ssh`,
        status: 'error',
        durationMs: 0,
        message: `Unexpected error testing ${host.name}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return allResults;
}
