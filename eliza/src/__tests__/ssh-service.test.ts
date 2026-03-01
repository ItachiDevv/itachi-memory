import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as child_process from 'child_process';
import { EventEmitter } from 'events';

// ============================================================
// Mock external dependencies
// ============================================================

mock.module('@elizaos/core', () => ({
  Service: class {
    static serviceType = 'base';
    capabilityDescription = '';
    constructor(runtime?: any) { (this as any).runtime = runtime; }
  },
}));

// ============================================================
// Import SSHService after mocks are set up
// ============================================================

import { SSHService, type SSHTarget, type InteractiveSession } from '../plugins/itachi-tasks/services/ssh-service.js';

// ============================================================
// Test helpers
// ============================================================

/** Saved env vars to restore after each test */
let savedEnv: Record<string, string | undefined> = {};

/** SSH-related env var prefixes to clean */
const SSH_ENV_PREFIXES = ['COOLIFY_SSH_', 'ITACHI_SSH_'];

function clearSSHEnvVars() {
  for (const key of Object.keys(process.env)) {
    if (SSH_ENV_PREFIXES.some(p => key.startsWith(p))) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
}

function restoreEnv() {
  // Remove any SSH vars set during test
  for (const key of Object.keys(process.env)) {
    if (SSH_ENV_PREFIXES.some(p => key.startsWith(p))) {
      delete process.env[key];
    }
  }
  // Restore original values
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val !== undefined) process.env[key] = val;
  }
  savedEnv = {};
}

function makeMockRuntime() {
  const logs: { level: string; msg: string }[] = [];
  return {
    runtime: {
      getService: () => null,
      getSetting: () => null,
      logger: {
        info: (...args: any[]) => logs.push({ level: 'info', msg: args.join(' ') }),
        warn: (...args: any[]) => logs.push({ level: 'warn', msg: args.join(' ') }),
        error: (...args: any[]) => logs.push({ level: 'error', msg: args.join(' ') }),
      },
    } as any,
    logs,
  };
}

/** Create a mock ChildProcess for spawn */
function makeMockChildProcess(pid: number = 1234): any {
  const proc = new EventEmitter() as any;
  proc.pid = pid;
  proc.stdin = { write: mock(() => {}), end: mock(() => {}) };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = mock(() => {});
  return proc;
}

// ============================================================
// Tests
// ============================================================

describe('SSHService', () => {
  beforeEach(() => {
    clearSSHEnvVars();
  });

  afterEach(() => {
    restoreEnv();
  });

  // ── Target loading from env vars ──────────────────────────

  describe('loadTargets (via constructor)', () => {
    it('should load coolify target from COOLIFY_SSH_* vars', () => {
      process.env.COOLIFY_SSH_HOST = '10.0.0.1';
      process.env.COOLIFY_SSH_USER = 'deploy';
      process.env.COOLIFY_SSH_KEY_PATH = '/keys/coolify';
      process.env.COOLIFY_SSH_PORT = '2222';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const target = service.getTarget('coolify');
      expect(target).toBeDefined();
      expect(target!.host).toBe('10.0.0.1');
      expect(target!.user).toBe('deploy');
      expect(target!.keyPath).toBe('/keys/coolify');
      expect(target!.port).toBe(2222);
    });

    it('should default coolify user to root and port to 22', () => {
      process.env.COOLIFY_SSH_HOST = '10.0.0.2';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const target = service.getTarget('coolify');
      expect(target).toBeDefined();
      expect(target!.user).toBe('root');
      expect(target!.port).toBe(22);
      expect(target!.keyPath).toBeUndefined();
    });

    it('should load ITACHI_SSH_<NAME>_HOST targets for known names', () => {
      process.env.ITACHI_SSH_MAC_HOST = '100.100.1.1';
      process.env.ITACHI_SSH_MAC_USER = 'itachisan';
      process.env.ITACHI_SSH_MAC_KEY = '/keys/mac';

      process.env.ITACHI_SSH_WINDOWS_HOST = '100.100.1.2';
      process.env.ITACHI_SSH_WINDOWS_USER = 'admin';
      process.env.ITACHI_SSH_WINDOWS_PORT = '3022';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const mac = service.getTarget('mac');
      expect(mac).toBeDefined();
      expect(mac!.host).toBe('100.100.1.1');
      expect(mac!.user).toBe('itachisan');
      expect(mac!.keyPath).toBe('/keys/mac');

      const win = service.getTarget('windows');
      expect(win).toBeDefined();
      expect(win!.host).toBe('100.100.1.2');
      expect(win!.user).toBe('admin');
      expect(win!.port).toBe(3022);
    });

    it('should have empty targets when no env vars are set', () => {
      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      expect(service.getTargets().size).toBe(0);
    });

    it('should not overwrite coolify target with ITACHI_SSH_COOLIFY_HOST', () => {
      process.env.COOLIFY_SSH_HOST = '10.0.0.1';
      process.env.COOLIFY_SSH_USER = 'deploy';
      process.env.ITACHI_SSH_COOLIFY_HOST = '10.0.0.99';
      process.env.ITACHI_SSH_COOLIFY_USER = 'other';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const target = service.getTarget('coolify');
      expect(target!.host).toBe('10.0.0.1');
      expect(target!.user).toBe('deploy');
    });
  });

  // ── isWindowsTarget ───────────────────────────────────────

  describe('isWindowsTarget', () => {
    it('should return true for windows-like names', () => {
      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      expect(service.isWindowsTarget('windows')).toBe(true);
      expect(service.isWindowsTarget('win')).toBe(true);
      expect(service.isWindowsTarget('pc')).toBe(true);
      expect(service.isWindowsTarget('desktop')).toBe(true);
    });

    it('should return false for non-windows names', () => {
      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      expect(service.isWindowsTarget('mac')).toBe(false);
      expect(service.isWindowsTarget('coolify')).toBe(false);
      expect(service.isWindowsTarget('hetzner')).toBe(false);
      expect(service.isWindowsTarget('server')).toBe(false);
    });

    it('should be case insensitive', () => {
      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      expect(service.isWindowsTarget('WINDOWS')).toBe(true);
      expect(service.isWindowsTarget('Windows')).toBe(true);
      expect(service.isWindowsTarget('WIN')).toBe(true);
      expect(service.isWindowsTarget('PC')).toBe(true);
    });
  });

  // ── getTargets / getTarget ────────────────────────────────

  describe('getTargets / getTarget', () => {
    it('should return all configured targets', () => {
      process.env.COOLIFY_SSH_HOST = '10.0.0.1';
      process.env.ITACHI_SSH_MAC_HOST = '10.0.0.2';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const targets = service.getTargets();
      expect(targets.size).toBe(2);
      expect(targets.has('coolify')).toBe(true);
      expect(targets.has('mac')).toBe(true);
    });

    it('should do case-insensitive lookup', () => {
      process.env.ITACHI_SSH_MAC_HOST = '10.0.0.3';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      expect(service.getTarget('MAC')).toBeDefined();
      expect(service.getTarget('Mac')).toBeDefined();
      expect(service.getTarget('mac')).toBeDefined();
    });

    it('should return undefined for unknown target', () => {
      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      expect(service.getTarget('nonexistent')).toBeUndefined();
    });
  });

  // ── exec ──────────────────────────────────────────────────

  describe('exec', () => {
    it('should return error result for unknown target', async () => {
      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const result = await service.exec('unknown', 'echo hello');
      expect(result.success).toBe(false);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Unknown SSH target');
      expect(result.stdout).toBe('');
    });

    it('should call execOnTarget with correct args for Unix target', async () => {
      process.env.ITACHI_SSH_MAC_HOST = '10.0.0.5';
      process.env.ITACHI_SSH_MAC_USER = 'itachisan';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const execOnTargetSpy = spyOn(service, 'execOnTarget').mockResolvedValue({
        stdout: 'ok', stderr: '', code: 0, success: true,
      });

      const result = await service.exec('mac', 'echo hello', 5000);
      expect(result.success).toBe(true);
      expect(execOnTargetSpy).toHaveBeenCalledTimes(1);

      const [target, command, timeout, isWindows] = execOnTargetSpy.mock.calls[0];
      expect((target as SSHTarget).host).toBe('10.0.0.5');
      expect(command).toBe('echo hello');
      expect(timeout).toBe(5000);
      expect(isWindows).toBe(false);
    });

    it('should pass isWindows=true for Windows targets', async () => {
      process.env.ITACHI_SSH_WINDOWS_HOST = '10.0.0.6';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const execOnTargetSpy = spyOn(service, 'execOnTarget').mockResolvedValue({
        stdout: '', stderr: '', code: 0, success: true,
      });

      await service.exec('windows', 'dir');

      const [, , , isWindows] = execOnTargetSpy.mock.calls[0];
      expect(isWindows).toBe(true);
    });

    it('should be case insensitive on target name', async () => {
      process.env.ITACHI_SSH_MAC_HOST = '10.0.0.7';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const execOnTargetSpy = spyOn(service, 'execOnTarget').mockResolvedValue({
        stdout: '', stderr: '', code: 0, success: true,
      });

      await service.exec('MAC', 'ls');
      expect(execOnTargetSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── execOnTarget ──────────────────────────────────────────

  describe('execOnTarget', () => {
    it('should build correct SSH args for Unix target', async () => {
      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const execFileSpy = spyOn(child_process, 'execFile').mockImplementation(
        ((_cmd: any, _args: any, _opts: any, callback: any) => {
          callback(null, 'output', '');
          return {} as any;
        }) as any,
      );

      const target: SSHTarget = { host: '10.0.0.10', user: 'testuser', keyPath: '/keys/test', port: 2222 };
      const result = await service.execOnTarget(target, 'echo hello', 5000, false);

      expect(result.success).toBe(true);
      expect(result.stdout).toBe('output');

      const args = execFileSpy.mock.calls[0][1] as string[];
      expect(args).toContain('-i');
      expect(args).toContain('/keys/test');
      expect(args).toContain('-p');
      expect(args).toContain('2222');
      expect(args).toContain('testuser@10.0.0.10');
      // Unix command should have PATH export
      const cmd = args[args.length - 1];
      expect(cmd).toContain('export PATH=');
      expect(cmd).toContain('echo hello');

      execFileSpy.mockRestore();
    });

    it('should wrap command with PowerShell for Windows target', async () => {
      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const execFileSpy = spyOn(child_process, 'execFile').mockImplementation(
        ((_cmd: any, _args: any, _opts: any, callback: any) => {
          callback(null, 'win-output', '');
          return {} as any;
        }) as any,
      );

      const target: SSHTarget = { host: '10.0.0.11', user: 'admin' };
      await service.execOnTarget(target, 'cd folder && dir', 5000, true);

      const args = execFileSpy.mock.calls[0][1] as string[];
      const cmd = args[args.length - 1];
      expect(cmd).toContain('powershell.exe');
      expect(cmd).toContain('-NoProfile');
      // && should be replaced with ;
      expect(cmd).toContain('; ');
      expect(cmd).not.toContain(' && ');

      execFileSpy.mockRestore();
    });

    it('should omit -i and -p flags when keyPath/port not set', async () => {
      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const execFileSpy = spyOn(child_process, 'execFile').mockImplementation(
        ((_cmd: any, _args: any, _opts: any, callback: any) => {
          callback(null, '', '');
          return {} as any;
        }) as any,
      );

      const target: SSHTarget = { host: '10.0.0.12', user: 'root' };
      await service.execOnTarget(target, 'ls', 5000, false);

      const args = execFileSpy.mock.calls[0][1] as string[];
      expect(args).not.toContain('-i');
      expect(args).not.toContain('-p');

      execFileSpy.mockRestore();
    });

    it('should return error code on process failure', async () => {
      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const execFileSpy = spyOn(child_process, 'execFile').mockImplementation(
        ((_cmd: any, _args: any, _opts: any, callback: any) => {
          const err: any = new Error('Connection refused');
          err.code = 255;
          callback(err, '', 'Connection refused');
          return {} as any;
        }) as any,
      );

      const target: SSHTarget = { host: '10.0.0.13', user: 'root' };
      const result = await service.execOnTarget(target, 'ls', 5000, false);

      expect(result.success).toBe(false);
      expect(result.code).toBe(255);
      expect(result.stderr).toBe('Connection refused');

      execFileSpy.mockRestore();
    });
  });

  // ── spawnInteractiveSession ───────────────────────────────

  describe('spawnInteractiveSession', () => {
    it('should return null for unknown target', () => {
      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const result = service.spawnInteractiveSession(
        'nonexistent', 'ls',
        () => {}, () => {}, () => {},
      );
      expect(result).toBeNull();
    });

    it('should return InteractiveSession with pid, write, kill for valid target', () => {
      process.env.ITACHI_SSH_MAC_HOST = '10.0.0.20';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const mockProc = makeMockChildProcess(5678);
      const spawnSpy = spyOn(child_process, 'spawn').mockReturnValue(mockProc);

      const session = service.spawnInteractiveSession(
        'mac', 'echo hi',
        () => {}, () => {}, () => {},
      );

      expect(session).not.toBeNull();
      expect(session!.pid).toBe(5678);
      expect(typeof session!.write).toBe('function');
      expect(typeof session!.kill).toBe('function');

      spawnSpy.mockRestore();
    });

    it('should add -tt flag when usePty is true for non-Windows target', () => {
      process.env.ITACHI_SSH_MAC_HOST = '10.0.0.21';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const mockProc = makeMockChildProcess();
      const spawnSpy = spyOn(child_process, 'spawn').mockReturnValue(mockProc);

      service.spawnInteractiveSession(
        'mac', 'echo hi',
        () => {}, () => {}, () => {},
        600_000, { usePty: true },
      );

      const args = spawnSpy.mock.calls[0][1] as string[];
      expect(args).toContain('-tt');

      spawnSpy.mockRestore();
    });

    it('should NOT add -tt flag for Windows target even with usePty', () => {
      process.env.ITACHI_SSH_WINDOWS_HOST = '10.0.0.22';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const mockProc = makeMockChildProcess();
      const spawnSpy = spyOn(child_process, 'spawn').mockReturnValue(mockProc);

      service.spawnInteractiveSession(
        'windows', 'dir',
        () => {}, () => {}, () => {},
        600_000, { usePty: true },
      );

      const args = spawnSpy.mock.calls[0][1] as string[];
      expect(args).not.toContain('-tt');

      spawnSpy.mockRestore();
    });

    it('should NOT add -tt flag when usePty is false', () => {
      process.env.ITACHI_SSH_MAC_HOST = '10.0.0.23';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const mockProc = makeMockChildProcess();
      const spawnSpy = spyOn(child_process, 'spawn').mockReturnValue(mockProc);

      service.spawnInteractiveSession(
        'mac', 'echo hi',
        () => {}, () => {}, () => {},
        600_000, { usePty: false },
      );

      const args = spawnSpy.mock.calls[0][1] as string[];
      expect(args).not.toContain('-tt');

      spawnSpy.mockRestore();
    });

    it('should end stdin when closeStdin option is true', () => {
      process.env.ITACHI_SSH_MAC_HOST = '10.0.0.24';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const mockProc = makeMockChildProcess();
      const spawnSpy = spyOn(child_process, 'spawn').mockReturnValue(mockProc);

      service.spawnInteractiveSession(
        'mac', 'claude -p "do something"',
        () => {}, () => {}, () => {},
        600_000, { closeStdin: true },
      );

      expect(mockProc.stdin.end).toHaveBeenCalledTimes(1);

      spawnSpy.mockRestore();
    });

    it('should NOT end stdin when closeStdin is not set', () => {
      process.env.ITACHI_SSH_MAC_HOST = '10.0.0.25';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const mockProc = makeMockChildProcess();
      const spawnSpy = spyOn(child_process, 'spawn').mockReturnValue(mockProc);

      service.spawnInteractiveSession(
        'mac', 'claude',
        () => {}, () => {}, () => {},
      );

      expect(mockProc.stdin.end).not.toHaveBeenCalled();

      spawnSpy.mockRestore();
    });

    it('should include key and port in SSH args when configured', () => {
      process.env.ITACHI_SSH_VPS_HOST = '10.0.0.30';
      process.env.ITACHI_SSH_VPS_USER = 'deploy';
      process.env.ITACHI_SSH_VPS_KEY = '/keys/vps_key';
      process.env.ITACHI_SSH_VPS_PORT = '3333';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const mockProc = makeMockChildProcess();
      const spawnSpy = spyOn(child_process, 'spawn').mockReturnValue(mockProc);

      service.spawnInteractiveSession(
        'vps', 'ls -la',
        () => {}, () => {}, () => {},
      );

      const args = spawnSpy.mock.calls[0][1] as string[];
      expect(args).toContain('-i');
      expect(args).toContain('/keys/vps_key');
      expect(args).toContain('-p');
      expect(args).toContain('3333');

      spawnSpy.mockRestore();
    });

    it('should route stdout/stderr to callbacks', () => {
      process.env.ITACHI_SSH_MAC_HOST = '10.0.0.26';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const mockProc = makeMockChildProcess();
      const spawnSpy = spyOn(child_process, 'spawn').mockReturnValue(mockProc);

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      service.spawnInteractiveSession(
        'mac', 'echo hi',
        (chunk) => stdoutChunks.push(chunk),
        (chunk) => stderrChunks.push(chunk),
        () => {},
      );

      mockProc.stdout.emit('data', Buffer.from('hello'));
      mockProc.stderr.emit('data', Buffer.from('warning'));

      expect(stdoutChunks).toEqual(['hello']);
      expect(stderrChunks).toEqual(['warning']);

      spawnSpy.mockRestore();
    });

    it('should call onExit with exit code on process close', () => {
      process.env.ITACHI_SSH_MAC_HOST = '10.0.0.27';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const mockProc = makeMockChildProcess();
      const spawnSpy = spyOn(child_process, 'spawn').mockReturnValue(mockProc);

      let exitCode: number | null = null;

      service.spawnInteractiveSession(
        'mac', 'echo hi',
        () => {}, () => {},
        (code) => { exitCode = code; },
      );

      mockProc.emit('exit', 0);
      mockProc.emit('close');

      expect(exitCode).toBe(0);

      spawnSpy.mockRestore();
    });
  });

  // ── stop ──────────────────────────────────────────────────

  describe('stop', () => {
    it('should kill all active sessions and clear the map', async () => {
      process.env.ITACHI_SSH_MAC_HOST = '10.0.0.40';

      const { runtime } = makeMockRuntime();
      const service = new SSHService(runtime);

      const mockProc = makeMockChildProcess(9999);
      const spawnSpy = spyOn(child_process, 'spawn').mockReturnValue(mockProc);

      service.spawnInteractiveSession(
        'mac', 'long-running-cmd',
        () => {}, () => {}, () => {},
      );

      await service.stop();

      expect(mockProc.kill).toHaveBeenCalled();

      spawnSpy.mockRestore();
    });
  });
});
