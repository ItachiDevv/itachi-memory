import { Service, type IAgentRuntime } from '@elizaos/core';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

export interface SSHTarget {
  host: string;
  user: string;
  keyPath?: string;
  port?: number;
}

export interface SSHResult {
  stdout: string;
  stderr: string;
  code: number;
  success: boolean;
}

/**
 * SSH service for executing commands on remote machines.
 * Uses the system `ssh` binary — works from Docker containers
 * if an SSH key is mounted and the target is reachable (e.g. via Tailscale).
 */
export interface InteractiveSession {
  pid: number;
  write: (data: string) => void;
  kill: () => void;
  timedOut: boolean;
}

export class SSHService extends Service {
  static serviceType = 'ssh';
  capabilityDescription = 'Execute commands on remote machines via SSH';

  private targets: Map<string, SSHTarget> = new Map();
  private activeSessions: Map<string, ChildProcess> = new Map();

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.loadTargets();
  }

  static async start(runtime: IAgentRuntime): Promise<SSHService> {
    const service = new SSHService(runtime);
    const count = service.targets.size;
    if (count === 0) {
      runtime.logger.warn('SSHService: No SSH targets configured! Set COOLIFY_SSH_HOST or ITACHI_SSH_<NAME>_HOST env vars.');
    } else {
      for (const [name, target] of service.targets) {
        runtime.logger.info(`SSHService: target "${name}" → ${target.user}@${target.host}:${target.port || 22}${target.keyPath ? ` (key: ${target.keyPath})` : ''}`);
      }
    }
    runtime.logger.info(`SSHService started with ${count} target(s)`);
    return service;
  }

  async stop(): Promise<void> {
    // Kill all active interactive sessions
    for (const [id, proc] of this.activeSessions) {
      try { proc.kill('SIGTERM'); } catch { /* best-effort */ }
      this.runtime.logger.info(`SSHService: killed session ${id}`);
    }
    this.activeSessions.clear();
    this.runtime.logger.info('SSHService stopped');
  }

  /**
   * If ITACHI_SSH_DEPLOY_KEY_CONTENT is set, write it to ~/.ssh/itachi_deploy
   * so all targets can reference it by path. Runs once at startup.
   */
  private ensureDeployKey(): string | undefined {
    const content = process.env.ITACHI_SSH_DEPLOY_KEY_CONTENT;
    if (!content) return undefined;
    const sshDir = join(homedir(), '.ssh');
    const keyPath = join(sshDir, 'itachi_deploy');
    try {
      mkdirSync(sshDir, { recursive: true, mode: 0o700 });
      // Normalize line endings — env vars may have literal \n
      const normalized = content.replace(/\\n/g, '\n');
      writeFileSync(keyPath, normalized, { mode: 0o600 });
    } catch { /* best-effort */ }
    return keyPath;
  }

  /**
   * Load SSH targets from environment variables.
   * Format: ITACHI_SSH_<NAME>_HOST, ITACHI_SSH_<NAME>_USER, ITACHI_SSH_<NAME>_KEY, ITACHI_SSH_<NAME>_PORT
   * Also supports ITACHI_SSH_<NAME>_KEY_CONTENT for inline key (e.g. in Docker/Coolify).
   * Also loads the special COOLIFY_SSH_* vars for backward compat.
   */
  private loadTargets(): void {
    const s = (key: string): string => process.env[key] || '';

    // Write shared deploy key from env content if provided
    const deployKeyPath = this.ensureDeployKey();

    // Resolve key path: prefer explicit KEY_PATH, fall back to KEY_CONTENT-written path, then deploy key
    const resolveKey = (nameUpper: string): string | undefined => {
      const explicit = s(`ITACHI_SSH_${nameUpper}_KEY`) || s(`ITACHI_SSH_${nameUpper}_KEY_PATH`);
      if (explicit) return explicit;
      const content = s(`ITACHI_SSH_${nameUpper}_KEY_CONTENT`);
      if (content) {
        const keyPath = join(tmpdir(), `itachi-key-${nameUpper.toLowerCase()}`);
        try { writeFileSync(keyPath, content.replace(/\\n/g, '\n'), { mode: 0o600 }); } catch { /* best-effort */ }
        return keyPath;
      }
      return deployKeyPath;
    };

    // Load COOLIFY_SSH_* as the "coolify" target (backward compat)
    const coolifyHost = s('COOLIFY_SSH_HOST');
    if (coolifyHost) {
      const coolifyKey = s('COOLIFY_SSH_KEY_PATH') || deployKeyPath;
      this.targets.set('coolify', {
        host: coolifyHost,
        user: s('COOLIFY_SSH_USER') || 'root',
        keyPath: coolifyKey,
        port: parseInt(s('COOLIFY_SSH_PORT') || '22', 10),
      });
    }

    // Scan for ITACHI_SSH_<NAME>_HOST pattern
    const knownNames = ['coolify', 'mac', 'windows', 'hoodie', 'surface', 'hetzner', 'vps', 'server', 'itachi-mem', 'linux'];
    for (const name of knownNames) {
      if (this.targets.has(name)) continue;
      const nameUpper = name.toUpperCase().replace(/-/g, '_');
      const host = s(`ITACHI_SSH_${nameUpper}_HOST`);
      if (!host) continue;
      this.targets.set(name, {
        host,
        user: s(`ITACHI_SSH_${nameUpper}_USER`) || 'root',
        keyPath: resolveKey(nameUpper),
        port: parseInt(s(`ITACHI_SSH_${nameUpper}_PORT`) || '22', 10),
      });
    }
  }

  /** Known Windows target names — skip Unix PATH export for these */
  private static WINDOWS_TARGETS = new Set(['windows', 'win', 'pc', 'desktop', 'surface', 'hoodie']);

  /** Check if a target name refers to a Windows machine */
  isWindowsTarget(name: string): boolean {
    return SSHService.WINDOWS_TARGETS.has(name.toLowerCase());
  }

  /**
   * Adapt a Unix-style command for Windows PowerShell 5.1:
   * - Replace `&&` with `;` (PS 5.1 doesn't support `&&`)
   * - Replace bash single-quote escapes `'\''` with PowerShell `''`
   */
  private adaptForWindows(command: string): string {
    return command
      .replace(/\s*&&\s*/g, '; ')
      .replace(/'\\'''/g, "''");
  }

  /** Get all configured SSH targets */
  getTargets(): Map<string, SSHTarget> {
    return this.targets;
  }

  /** Get a specific target by name */
  getTarget(name: string): SSHTarget | undefined {
    return this.targets.get(name.toLowerCase());
  }

  /**
   * Execute a command on a remote machine via SSH.
   * Timeout: 30s default, configurable.
   */
  async exec(targetName: string, command: string, timeoutMs: number = 30_000): Promise<SSHResult> {
    const target = this.targets.get(targetName.toLowerCase());
    if (!target) {
      return { stdout: '', stderr: `Unknown SSH target: ${targetName}`, code: 1, success: false };
    }

    return this.execOnTarget(target, command, timeoutMs, this.isWindowsTarget(targetName));
  }

  /**
   * Spawn a long-running interactive SSH session.
   * Returns a handle with write() (stdin), kill(), and pid.
   * Callbacks fire on stdout/stderr chunks and on process exit.
   *
   * @param options.usePty - Force PTY allocation via -tt. Default: false for
   *   stream-json mode (clean pipes), true only for legacy TUI mode.
   */
  spawnInteractiveSession(
    targetName: string,
    command: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
    onExit: (code: number) => void,
    timeoutMs: number = 600_000,
    options?: { usePty?: boolean; closeStdin?: boolean },
  ): InteractiveSession | null {
    const target = this.targets.get(targetName.toLowerCase());
    if (!target) return null;

    const args: string[] = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
    ];

    // Only add -tt (force PTY) when explicitly requested.
    // Stream-json mode uses clean pipes — no PTY needed.
    // Windows: never use PTY (claude -p print mode works via pipes).
    if (options?.usePty && !this.isWindowsTarget(targetName)) {
      args.push('-tt');
    }

    if (target.keyPath) {
      args.push('-i', target.keyPath);
    }
    if (target.port && target.port !== 22) {
      args.push('-p', String(target.port));
    }

    // Wrap command to ensure common bin dirs are in PATH (non-login SSH shells
    // don't source .zshrc/.bash_profile, so /usr/local/bin etc. are missing).
    // Windows targets: adapt syntax for PowerShell 5.1, then wrap with powershell.exe.
    const wrappedCommand = this.isWindowsTarget(targetName)
      ? `powershell.exe -NoProfile -Command "${this.adaptForWindows(command).replace(/"/g, '\\"')}"`
      : `export PATH="$HOME/.claude:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH" && ${command}`;
    args.push(`${target.user}@${target.host}`, wrappedCommand);

    const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const sessionId = `${targetName}-${proc.pid || Date.now()}`;

    // Close stdin only when explicitly requested (e.g. task executor using -p mode).
    // Interactive sessions keep stdin open for multi-turn input.
    if (options?.closeStdin) {
      proc.stdin?.end();
    }

    this.activeSessions.set(sessionId, proc);

    proc.stdout?.on('data', (data: Buffer) => {
      onStdout(data.toString());
    });

    proc.stderr?.on('data', (data: Buffer) => {
      onStderr(data.toString());
    });

    // Use 'close' instead of 'exit' — 'close' fires only after all stdio
    // streams are fully consumed, preventing truncated output when the remote
    // process exits quickly (e.g. auth failure producing only a few NDJSON lines).
    let exitCode: number | null = null;
    proc.on('exit', (code) => {
      exitCode = code;
    });
    proc.on('close', () => {
      this.activeSessions.delete(sessionId);
      onExit(exitCode ?? 1);
    });

    proc.on('error', (err) => {
      this.runtime.logger.error(`SSH session ${sessionId} error: ${err.message}`);
      this.activeSessions.delete(sessionId);
      onExit(1);
    });

    // Session handle + timeout — session created first so timeout can set timedOut flag.
    // Timer declared with let so session.kill() can reference it via closure.
    let timer: ReturnType<typeof setTimeout>;
    const session: InteractiveSession = {
      pid: proc.pid || 0,
      write: (data: string) => { proc.stdin?.write(data); },
      kill: () => {
        clearTimeout(timer);
        try { proc.kill('SIGTERM'); } catch { /* best-effort */ }
        this.activeSessions.delete(sessionId);
      },
      timedOut: false,
    };

    // Timeout safety net — sets timedOut on session BEFORE killing process
    timer = setTimeout(() => {
      if (this.activeSessions.has(sessionId)) {
        session.timedOut = true;
        this.runtime.logger.warn(`SSH session ${sessionId} timed out after ${timeoutMs}ms`);
        try { proc.kill('SIGTERM'); } catch { /* best-effort */ }
      }
    }, timeoutMs);

    // Clear timeout when process exits naturally
    proc.on('exit', () => clearTimeout(timer));

    this.runtime.logger.info(`Spawned interactive session ${sessionId}: ssh ${target.user}@${target.host}`);

    return session;
  }

  /** Execute on a specific target config */
  async execOnTarget(target: SSHTarget, command: string, timeoutMs: number = 30_000, isWindows: boolean = false): Promise<SSHResult> {
    const args: string[] = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      '-o', 'BatchMode=yes',
    ];

    if (target.keyPath) {
      args.push('-i', target.keyPath);
    }
    if (target.port && target.port !== 22) {
      args.push('-p', String(target.port));
    }

    // Windows targets: adapt syntax for PowerShell 5.1; Unix targets need PATH export
    const wrappedCommand = isWindows
      ? `powershell.exe -NoProfile -Command "${this.adaptForWindows(command).replace(/"/g, '\\"')}"`
      : `export PATH="$HOME/.claude:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH" && ${command}`;
    args.push(`${target.user}@${target.host}`, wrappedCommand);

    return new Promise<SSHResult>((resolve) => {
      const proc = execFile('ssh', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (error as any).code ?? 1 : 0;
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          code: typeof code === 'number' ? code : 1,
          success: !error,
        });
      });
    });
  }
}
