import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { SSHService } from '../services/ssh-service.js';
import { MachineRegistryService } from '../services/machine-registry.js';
import { TaskService } from '../services/task-service.js';
import { DEFAULT_REPO_BASES } from '../shared/repo-utils.js';
import { stripBotMention, getTopicThreadId } from '../utils/telegram.js';
import { activeSessions } from '../shared/active-sessions.js';
import { browsingSessionMap } from '../utils/directory-browser.js';

// ── Machine name aliases → SSH target names ──────────────────────────
const MACHINE_ALIASES: Record<string, string> = {
  mac: 'mac', macbook: 'mac', 'mac air': 'mac', apple: 'mac',
  windows: 'windows', pc: 'windows', laptop: 'windows', win: 'windows', desktop: 'windows',
  hetzner: 'coolify', coolify: 'coolify', server: 'coolify', vps: 'coolify', cloud: 'coolify', bot: 'coolify',
};

// ── Intent detection patterns ────────────────────────────────────────
const INTENTS = {
  investigate: /\b(why|what.?s wrong|figure out|investigate|diagnose|debug|check.*(fail|error|issue|problem|crash|down|broken|wrong)|failing|crashed|broken|not working|went down)\b/i,
  logs: /\b(logs?|output|print|show.*(log|output)|tail)\b/i,
  status: /\b(status|how.?s|health|up|running|alive|check on)\b/i,
  restart: /\b(restart|reboot|bounce|kick|bring back)\b/i,
  deploy: /\b(deploy|redeploy|ship|push)\b/i,
  update: /\b(update|upgrade|pull.*(code|latest|new)|self.?update|rebuild)\b/i,
  containers: /\b(container|docker|process|service)\b/i,
  disk: /\b(disk|space|storage|full)\b/i,
  run: /\b(run|execute|do|command)\b/i,
};

// ── Diagnostic command sequences ─────────────────────────────────────
const DIAGNOSTICS: Record<string, { label: string; cmd: string }[]> = {
  investigate: [
    { label: 'Container status', cmd: 'docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" 2>/dev/null | head -20' },
    { label: 'Recent logs (errors)', cmd: 'docker ps -q --format "{{.Names}}" | head -3 | while read c; do echo "=== $c ==="; docker logs --tail 30 "$c" 2>&1 | grep -iE "error|fatal|panic|crash|exception|fail" | tail -10; done' },
    { label: 'System resources', cmd: 'echo "CPU: $(uptime)"; echo "Memory: $(free -h 2>/dev/null | grep Mem || vm_stat 2>/dev/null | head -5)"; echo "Disk: $(df -h / 2>/dev/null | tail -1)"' },
    { label: 'Recent logs (last 20)', cmd: 'docker ps --format "{{.Names}}" | head -1 | xargs -r docker logs --tail 20 2>&1' },
  ],
  status: [
    { label: 'Containers', cmd: 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "Docker not available"' },
    { label: 'Uptime & load', cmd: 'uptime 2>/dev/null || echo "uptime not available"' },
    { label: 'Disk usage', cmd: 'df -h / 2>/dev/null | tail -1' },
  ],
  disk: [
    { label: 'Disk usage', cmd: 'df -h 2>/dev/null' },
    { label: 'Largest dirs', cmd: 'du -sh /var/lib/docker/* 2>/dev/null | sort -rh | head -5' },
    { label: 'Docker space', cmd: 'docker system df 2>/dev/null' },
  ],
  logs: [
    { label: 'Recent logs', cmd: 'docker ps --format "{{.Names}}" | head -1 | xargs -r docker logs --tail 50 2>&1' },
  ],
  containers: [
    { label: 'All containers', cmd: 'docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}"' },
  ],
};

// ── Windows diagnostic commands ───────────────────────────────────────
const DIAGNOSTICS_WINDOWS: Record<string, { label: string; cmd: string }[]> = {
  investigate: [
    { label: 'Running processes (top CPU)', cmd: 'powershell -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name, Id, CPU, @{N=\'Mem(MB)\';E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize"' },
    { label: 'System info', cmd: 'powershell -Command "Get-CimInstance Win32_OperatingSystem | Select-Object Caption, @{N=\'MemUsedMB\';E={[math]::Round(($_.TotalVisibleMemorySize-$_.FreePhysicalMemory)/1KB)}}, @{N=\'MemTotalMB\';E={[math]::Round($_.TotalVisibleMemorySize/1KB)}}, LastBootUpTime | Format-List; Get-CimInstance Win32_Processor | Select-Object Name, LoadPercentage | Format-List"' },
    { label: 'Disk usage', cmd: 'powershell -Command "Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N=\'Used(GB)\';E={[math]::Round($_.Used/1GB,1)}}, @{N=\'Free(GB)\';E={[math]::Round($_.Free/1GB,1)}}, @{N=\'Total(GB)\';E={[math]::Round(($_.Used+$_.Free)/1GB,1)}} | Format-Table -AutoSize"' },
    { label: 'Recent errors (Event Log)', cmd: 'powershell -Command "Get-WinEvent -LogName Application -MaxEvents 5 -FilterXPath \'*[System[Level=2]]\' 2>$null | Select-Object TimeCreated, Message | Format-List"' },
  ],
  status: [
    { label: 'System overview', cmd: 'powershell -Command "Get-CimInstance Win32_OperatingSystem | Select-Object Caption, CSName, LastBootUpTime | Format-List"' },
    { label: 'CPU & Memory', cmd: 'powershell -Command "Get-CimInstance Win32_Processor | Select-Object Name, LoadPercentage | Format-List; Get-CimInstance Win32_OperatingSystem | Select-Object @{N=\'MemUsedMB\';E={[math]::Round(($_.TotalVisibleMemorySize-$_.FreePhysicalMemory)/1KB)}}, @{N=\'MemTotalMB\';E={[math]::Round($_.TotalVisibleMemorySize/1KB)}} | Format-List"' },
    { label: 'Disk usage', cmd: 'powershell -Command "Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N=\'Used(GB)\';E={[math]::Round($_.Used/1GB,1)}}, @{N=\'Free(GB)\';E={[math]::Round($_.Free/1GB,1)}} | Format-Table -AutoSize"' },
  ],
  disk: [
    { label: 'Disk usage', cmd: 'powershell -Command "Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N=\'Used(GB)\';E={[math]::Round($_.Used/1GB,1)}}, @{N=\'Free(GB)\';E={[math]::Round($_.Free/1GB,1)}}, @{N=\'Total(GB)\';E={[math]::Round(($_.Used+$_.Free)/1GB,1)}} | Format-Table -AutoSize"' },
    { label: 'Largest folders', cmd: 'powershell -Command "Get-ChildItem C:\\ -Directory -ErrorAction SilentlyContinue | ForEach-Object { $size = (Get-ChildItem $_.FullName -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum; [PSCustomObject]@{Name=$_.Name; SizeGB=[math]::Round($size/1GB,2)} } | Sort-Object SizeGB -Descending | Select-Object -First 10 | Format-Table -AutoSize"' },
  ],
  logs: [
    { label: 'Recent application events', cmd: 'powershell -Command "Get-WinEvent -LogName Application -MaxEvents 20 2>$null | Select-Object TimeCreated, LevelDisplayName, Message | Format-List"' },
  ],
  containers: [
    { label: 'Docker containers', cmd: 'docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}" 2>nul || powershell -Command "Write-Output \'Docker not available on this machine\'"' },
  ],
};

// ── macOS diagnostic commands ─────────────────────────────────────────
const DIAGNOSTICS_DARWIN: Record<string, { label: string; cmd: string }[]> = {
  investigate: [
    { label: 'Running processes (top CPU)', cmd: 'ps aux --sort=-%cpu | head -15' },
    { label: 'System resources', cmd: 'echo "CPU: $(uptime)"; echo "Memory: $(vm_stat 2>/dev/null | head -5)"; echo "Disk: $(df -h / 2>/dev/null | tail -1)"' },
    { label: 'Docker status', cmd: 'docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" 2>/dev/null || echo "Docker not running"' },
    { label: 'Recent logs', cmd: 'docker ps --format "{{.Names}}" 2>/dev/null | head -1 | xargs -I{} docker logs --tail 20 {} 2>&1 || echo "No containers"' },
  ],
  status: [
    { label: 'System overview', cmd: 'echo "Host: $(hostname)"; uptime; echo "Disk: $(df -h / | tail -1)"' },
    { label: 'Docker', cmd: 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "Docker not available"' },
  ],
  disk: [
    { label: 'Disk usage', cmd: 'df -h 2>/dev/null' },
    { label: 'Largest dirs', cmd: 'du -sh /Users/*/Library /Users/*/Documents /opt /usr/local 2>/dev/null | sort -rh | head -10' },
  ],
  logs: [
    { label: 'Recent logs', cmd: 'docker ps --format "{{.Names}}" 2>/dev/null | head -1 | xargs -I{} docker logs --tail 50 {} 2>&1 || echo "No containers"' },
  ],
  containers: [
    { label: 'Docker containers', cmd: 'docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}" 2>/dev/null || echo "Docker not available"' },
  ],
};

/**
 * Pick the right diagnostics table based on the target OS.
 * Falls back to Linux (DIAGNOSTICS) if OS is unknown.
 */
function getDiagnosticsForOS(os: string | null | undefined): Record<string, { label: string; cmd: string }[]> {
  const osLower = (os || '').toLowerCase();
  if (osLower.includes('win')) return DIAGNOSTICS_WINDOWS;
  if (osLower.includes('darwin') || osLower.includes('mac')) return DIAGNOSTICS_DARWIN;
  return DIAGNOSTICS; // Linux / default
}

// ── Self-referential patterns (user asking about the bot itself → coolify) ──
const SELF_REF_PATTERNS = /\b(your(?:self| own)?|the bot|our (?:setup|vps|server|environment|config|env)|itachi.?s? (?:setup|server|env|config|storage|limits?|usage))\b/i;

/**
 * Extract a machine target name from natural language text.
 * Returns the SSH target name (e.g. "mac", "windows", "coolify") or null.
 */
function extractTarget(text: string, sshService: SSHService): string | null {
  const lower = text.toLowerCase();
  // Check aliases
  for (const [alias, target] of Object.entries(MACHINE_ALIASES)) {
    if (lower.includes(alias) && sshService.getTarget(target)) {
      return target;
    }
  }
  // Check direct target names
  for (const name of sshService.getTargets().keys()) {
    if (lower.includes(name)) return name;
  }
  return null;
}

/**
 * Extract target from conversation context (state.data.recentMessages).
 * Scans recent messages for machine mentions when the current message has none.
 */
function extractTargetFromContext(
  state: State | undefined,
  sshService: SSHService
): string | null {
  const recent = (state?.data?.recentMessages as Array<{ role: string; content: string }>) || [];
  // Scan backwards (most recent first) for a machine mention
  for (let i = recent.length - 1; i >= Math.max(0, recent.length - 8); i--) {
    const msg = recent[i];
    if (!msg?.content) continue;
    const found = extractTarget(msg.content, sshService);
    if (found) return found;
  }
  return null;
}

/**
 * Check if the user's message is self-referential (asking about the bot/our setup).
 * If so, default to coolify (where the bot runs).
 */
function isSelfReferential(text: string): boolean {
  return SELF_REF_PATTERNS.test(text);
}

/**
 * Detect the primary intent from natural language.
 */
function detectIntent(text: string): string {
  for (const [intent, pattern] of Object.entries(INTENTS)) {
    if (pattern.test(text)) return intent;
  }
  return 'investigate'; // Default: investigate
}

/**
 * Detect the OS of a target machine from the machine registry, falling back
 * to the SSH target name alias mapping for well-known names.
 */
async function detectTargetOS(runtime: IAgentRuntime, target: string): Promise<string | null> {
  // Try machine registry first
  try {
    const registry = runtime.getService<MachineRegistryService>('machine-registry');
    if (registry) {
      const { machine } = await registry.resolveMachine(target);
      if (machine?.os) return machine.os;
    }
  } catch {
    // Registry not available — fall through
  }

  // Fallback: infer from well-known target names
  const lower = target.toLowerCase();
  if (lower === 'windows' || lower === 'pc' || lower === 'win' || lower === 'desktop' || lower === 'laptop') return 'windows';
  if (lower === 'mac' || lower === 'macbook' || lower === 'apple') return 'darwin';
  // coolify/hetzner/server are Linux
  if (lower === 'coolify' || lower === 'hetzner' || lower === 'server' || lower === 'vps') return 'linux';
  return null;
}

/**
 * Run a sequence of diagnostic commands and format the results.
 */
async function runDiagnostics(
  sshService: SSHService,
  target: string,
  commands: { label: string; cmd: string }[],
  callback?: HandlerCallback,
): Promise<string> {
  const results: string[] = [];

  for (const step of commands) {
    const result = await sshService.exec(target, step.cmd, 15_000);
    const output = (result.stdout || result.stderr || '(no output)').trim();
    const truncated = output.length > 1500 ? output.substring(output.length - 1500) : output;
    results.push(`**${step.label}:**\n\`\`\`\n${truncated}\n\`\`\``);
  }

  const report = results.join('\n\n');
  return report;
}

export const coolifyControlAction: Action = {
  name: 'COOLIFY_CONTROL',
  description: 'Control remote servers via SSH. Handles both slash commands (/ssh, /deploy, /update, /logs, /containers, /restart-bot, /ssh-targets) AND natural language requests about machines (e.g. "check why the mac is failing", "restart the server", "what\'s running on windows").',
  similes: [
    'ssh command', 'deploy bot', 'update bot', 'view logs', 'restart bot',
    'list containers', 'server control', 'self update', 'pull code',
    'check server', 'investigate machine', 'why is it failing', 'machine status',
    'check the mac', 'ssh into', 'run on server', 'what is running',
  ],
  examples: [
    [
      { name: 'user', content: { text: '/ssh coolify docker ps' } },
      { name: 'Itachi', content: { text: '```\nCONTAINER ID  IMAGE       STATUS      NAMES\nabc123       eliza:latest Up 2 hours  eliza-bot\n```' } },
    ],
    [
      { name: 'user', content: { text: 'ssh into the mac and figure out why it\'s failing' } },
      { name: 'Itachi', content: { text: 'Investigating mac...\n\n**Container status:**\n```\nNAMES    STATUS         IMAGE\norchestrator  Up 4 hours  node:20\n```\n\n**Recent logs (errors):**\n```\n[runner] Engine "claude" auth failed: OAuth token expired\n```\n\n**System resources:**\n```\nCPU: load 0.5  Memory: 4.2G/8G  Disk: 62% used\n```\n\nThe orchestrator is running but Claude auth has expired. Run `claude auth login` on the Mac to fix it.' } },
    ],
    [
      { name: 'user', content: { text: 'check on the windows pc' } },
      { name: 'Itachi', content: { text: 'Checking windows...\n\n**Containers:**\n```\n(no docker containers running)\n```\n\n**Uptime:** 3 days\n**Disk:** 45% used\n\nThe Windows PC is up but no Docker containers are running.' } },
    ],
    [
      { name: 'user', content: { text: '/update' } },
      { name: 'Itachi', content: { text: 'Triggering rebuild from latest code...\nDeploy queued: iogcks0ww4osc8ckk0c088gs' } },
    ],
    [
      { name: 'user', content: { text: 'restart the bot' } },
      { name: 'Itachi', content: { text: 'Restarting bot on coolify...\nRestart succeeded: swoo0o4okwk8ocww4g4ks084-012513977521' } },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    // Skip messages in active session/browsing topics — the topic-input-relay handles those
    const threadId = await getTopicThreadId(runtime, message);
    if (threadId !== null && (activeSessions.has(threadId) || browsingSessionMap.has(threadId))) return false;

    const text = stripBotMention(message.content?.text || '');
    // Always match explicit slash commands (including /ops and /exec aliases)
    if (/^\/(ssh|deploy|update|logs|containers|restart[-_]bot|ssh[-_]targets|ssh[-_]test|ops|exec)\b/.test(text)) return true;
    // Match natural language about machines/servers
    const lower = text.toLowerCase();
    const mentionsMachine = Object.keys(MACHINE_ALIASES).some(alias => lower.includes(alias));
    const mentionsAction = /\b(ssh|check|investigate|deploy|restart|update|logs?|status|failing|broken|down|running|containers?|docker|fix|diagnose|debug|figure out)\b/i.test(text);
    if (mentionsMachine && mentionsAction) return true;
    // Match if they mention SSH explicitly
    if (/\bssh\b/i.test(text)) return true;
    // Match self-referential queries about the bot/setup + action word
    if (isSelfReferential(text) && mentionsAction) return true;
    // Match if conversation context has a recent machine target + current message has action word
    if (mentionsAction && !mentionsMachine) {
      const sshService = runtime.getService<SSHService>('ssh');
      if (sshService && extractTargetFromContext(state, sshService)) return true;
    }
    return false;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      // Double-guard: don't execute SSH commands for session topic messages
      const threadId = await getTopicThreadId(runtime, message);
      if (threadId !== null && (activeSessions.has(threadId) || browsingSessionMap.has(threadId))) {
        runtime.logger.info(`[coolify-control] Skipping handler — message is in active/browsing session topic ${threadId}`);
        return { success: true, data: { skippedSessionTopic: true } };
      }

      const sshService = runtime.getService<SSHService>('ssh');
      if (!sshService) {
        if (callback) await callback({ text: 'SSH service not available. Set COOLIFY_SSH_HOST in env.' });
        return { success: false, error: 'SSH service not available' };
      }

      const text = stripBotMention(message.content?.text || '');

      // ── Slash commands (existing behavior) ──────────────────────
      if (text.startsWith('/')) {
        return await handleSlashCommand(text, sshService, runtime, callback);
      }

      // ── Natural language handling ───────────────────────────────
      let target = extractTarget(text, sshService);
      let intent = detectIntent(text);

      // Fallback 1: self-referential queries about the bot → coolify
      if (!target && isSelfReferential(text) && sshService.getTarget('coolify')) {
        target = 'coolify';
        runtime.logger.info(`[coolify-control] Self-referential query → defaulting to coolify`);
      }

      // Fallback 2: check conversation context for recently mentioned target
      if (!target) {
        target = extractTargetFromContext(_state, sshService);
        if (target) {
          runtime.logger.info(`[coolify-control] Target "${target}" resolved from conversation context`);
        }
      }

      // Fallback 3: if only one SSH target exists, use it
      if (!target) {
        const targets = [...sshService.getTargets().keys()];
        if (targets.length === 1) {
          target = targets[0];
          runtime.logger.info(`[coolify-control] Only one target available → "${target}"`);
        }
      }

      // If defaulted to 'investigate' but user mentions a repo/project, treat as navigate
      if (intent === 'investigate' && (/\b(repo|project)\b/i.test(text) || /specifically\s+into/i.test(text))) {
        intent = 'navigate';
      }

      if (!target) {
        // No machine identified even after context search — ask once, don't loop
        const available = [...sshService.getTargets().keys()].join(', ');
        if (callback) await callback({
          text: `I need to know which machine to target. Available: **${available}**\n\nTip: say "on coolify" or "check the mac"`,
        });
        return { success: false, error: 'No target machine identified' };
      }

      // Handle specific intents
      switch (intent) {
        case 'update':
          return await handleSelfUpdate(runtime, sshService, callback);

        case 'restart': {
          if (callback) await callback({ text: `Restarting services on ${target}...` });
          const result = await sshService.exec(target, 'docker ps --format "{{.Names}}" | head -1 | xargs -r docker restart 2>&1 || echo "No containers to restart"', 60_000);
          const output = result.stdout || result.stderr || '(no output)';
          if (callback) await callback({ text: `Restart ${result.success ? 'succeeded' : 'failed'}:\n\`\`\`\n${output.substring(0, 1000)}\n\`\`\`` });
          return { success: result.success, data: { output } };
        }

        case 'deploy': {
          if (callback) await callback({ text: `Deploying on ${target}...` });
          let result = await sshService.exec(target, 'cd /data/coolify && docker compose pull && docker compose up -d 2>&1', 120_000);
          if (!result.success) {
            result = await sshService.exec(target, 'docker ps --format "{{.Names}}" | grep -i eliza | head -1 | xargs -r docker restart', 60_000);
          }
          const output = result.stdout || result.stderr || '(no output)';
          if (callback) await callback({ text: `Deploy ${result.success ? 'succeeded' : 'failed'}:\n\`\`\`\n${output.substring(0, 2000)}\n\`\`\`` });
          return { success: result.success, data: { output } };
        }

        case 'run': {
          // Try to extract the actual command from the message
          // "run docker ps on the mac" → "docker ps"
          const cmdMatch = text.match(/(?:run|execute|do)\s+(?:the\s+)?(?:command\s+)?[`"']?(.+?)[`"']?\s+(?:on|at|in)\s/i)
            || text.match(/(?:on|at|in)\s+(?:the\s+)?\w+\s+(?:and\s+)?(?:run|execute|do)\s+[`"']?(.+?)[`"']?$/i);
          if (cmdMatch) {
            const cmd = cmdMatch[1].trim();
            if (callback) await callback({ text: `Running on ${target}: \`${cmd}\`` });
            const result = await sshService.exec(target, cmd, 60_000);
            const output = result.stdout || result.stderr || '(no output)';
            const truncated = output.length > 3000 ? output.substring(output.length - 3000) : output;
            if (callback) await callback({ text: `\`\`\`\n${truncated}\n\`\`\`` });
            return { success: result.success, data: { output: truncated } };
          }
          // Fall through to investigate if we can't parse the command
        }

        case 'navigate': {
          // User wants to browse a specific repo/project on the target machine
          const taskService = runtime.getService<TaskService>('itachi-tasks');
          let matchedRepo: { name: string; repo_url: string | null } | undefined;
          if (taskService) {
            try {
              const repos = await taskService.getMergedRepos();
              matchedRepo = repos.find(r => {
                const pat = new RegExp(`\\b${r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                return pat.test(text);
              });
            } catch { /* registry unavailable */ }
          }

          if (matchedRepo) {
            const base = DEFAULT_REPO_BASES[target] || '~/repos';
            const repoPath = `${base}/${matchedRepo.name}`;
            const navOS = await detectTargetOS(runtime, target);
            const isWin = navOS?.toLowerCase().includes('win');

            if (callback) await callback({ text: `Navigating to **${matchedRepo.name}** on ${target}...` });

            const listCmd = isWin
              ? `powershell -Command "if (Test-Path '${repoPath}') { Get-ChildItem '${repoPath}' | Format-Table Mode, LastWriteTime, Length, Name -AutoSize } else { Write-Output 'Directory not found: ${repoPath}' }"`
              : `if [ -d "${repoPath}" ]; then ls -la "${repoPath}"; else echo "Directory not found: ${repoPath}"; fi`;

            const navResult = await sshService.exec(target, listCmd, 15_000);
            const navOutput = (navResult.stdout || navResult.stderr || '(no output)').trim();
            const navTrunc = navOutput.length > 3000 ? navOutput.substring(0, 3000) : navOutput;

            if (callback) await callback({
              text: `**${matchedRepo.name}** on ${target} (\`${repoPath}\`):\n\`\`\`\n${navTrunc}\n\`\`\``,
            });
            return { success: true, data: { target, project: matchedRepo.name, repoPath, output: navTrunc } };
          }

          // No repo matched — fall through to investigate
          if (callback) await callback({ text: `No matching repo found in prompt. Investigating ${target} instead...` });
          const navDiagOS = await detectTargetOS(runtime, target);
          const navDiagTable = getDiagnosticsForOS(navDiagOS);
          const navReport = await runDiagnostics(sshService, target, navDiagTable.investigate, callback);
          if (callback) await callback({ text: navReport });
          return { success: true, data: { target, intent: 'investigate', report: navReport } };
        }

        default: {
          // investigate, status, logs, disk, containers — run OS-appropriate diagnostics
          const targetOS = await detectTargetOS(runtime, target);
          const diagTable = getDiagnosticsForOS(targetOS);
          const diagSteps = diagTable[intent] || diagTable.investigate;
          if (callback) await callback({ text: `Investigating ${target}${targetOS ? ` (${targetOS})` : ''}...` });
          const report = await runDiagnostics(sshService, target, diagSteps, callback);
          if (callback) await callback({ text: report });
          return { success: true, data: { target, intent, report } };
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (callback) await callback({ text: `SSH error: ${msg}` });
      return { success: false, error: msg };
    }
  },
};

// ── Slash command handler (unchanged logic, extracted) ──────────────
async function handleSlashCommand(
  text: string,
  sshService: SSHService,
  runtime: IAgentRuntime,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  // /ops <subcommand> — umbrella for server operations
  // Maps: /ops deploy → /deploy, /ops logs → /logs, /ops update → /update, etc.
  if (text.startsWith('/ops')) {
    const sub = text.substring('/ops'.length).trim();
    if (!sub) {
      if (callback) await callback({
        text: 'Usage: /ops <command>\n- `/ops deploy [target]` — redeploy bot\n- `/ops update` — pull latest code & rebuild\n- `/ops logs [lines]` — view container logs\n- `/ops containers [target]` — list containers\n- `/ops restart [target]` — restart bot container',
      });
      return { success: true };
    }
    // Re-route as the original slash command
    const rewritten = `/${sub}`;
    return await handleSlashCommand(rewritten, sshService, runtime, callback);
  }

  // /exec @target <cmd> — alias for /ssh <target> <cmd>
  if (text.startsWith('/exec')) {
    const execArgs = text.substring('/exec'.length).trim();
    const execMatch = execArgs.match(/^@?(\S+)\s+(.+)/s);
    if (!execMatch) {
      if (callback) await callback({ text: 'Usage: /exec @<target> <command>\nThis is an alias for /ssh <target> <command>' });
      return { success: false, error: 'Invalid exec format' };
    }
    const rewritten = `/ssh ${execMatch[1]} ${execMatch[2]}`;
    return await handleSlashCommand(rewritten, sshService, runtime, callback);
  }

  // /ssh-test — test connectivity to all SSH targets
  if (text.startsWith('/ssh-test') || text.startsWith('/ssh_test')) {
    const targets = sshService.getTargets();
    if (targets.size === 0) {
      if (callback) await callback({ text: 'No SSH targets configured.' });
      return { success: true, data: { targets: [] } };
    }
    if (callback) await callback({ text: `Testing ${targets.size} SSH target(s)...` });
    const results: string[] = [];
    for (const [name] of targets) {
      const start = Date.now();
      const result = await sshService.exec(name, 'echo ok', 10_000);
      const elapsed = Date.now() - start;
      if (result.success && result.stdout.includes('ok')) {
        results.push(`✅ ${name} — connected (${elapsed}ms)`);
      } else {
        const err = result.stderr || `exit code ${result.code}`;
        results.push(`❌ ${name} — failed: ${err.substring(0, 100)} (${elapsed}ms)`);
      }
    }
    if (callback) await callback({ text: `SSH connectivity test:\n${results.join('\n')}` });
    return { success: true, data: { results } };
  }

  // /ssh-targets
  if (text.startsWith('/ssh-targets') || text.startsWith('/ssh_targets')) {
    const targets = sshService.getTargets();
    if (targets.size === 0) {
      if (callback) await callback({ text: 'No SSH targets configured.' });
      return { success: true, data: { targets: [] } };
    }
    const lines = [...targets.entries()].map(([name, t]) => `- **${name}**: ${t.user}@${t.host}:${t.port || 22}`);
    if (callback) await callback({ text: `Configured SSH targets:\n${lines.join('\n')}` });
    return { success: true, data: { targets: [...targets.keys()] } };
  }

  // /update
  if (text.startsWith('/update')) {
    return await handleSelfUpdate(runtime, sshService, callback);
  }

  // /ssh targets — alias for /ssh-targets
  if (/^\/ssh\s+targets?\s*$/i.test(text)) {
    return await handleSlashCommand('/ssh-targets', sshService, runtime, callback);
  }

  // /ssh test — alias for /ssh-test
  if (/^\/ssh\s+test\s*$/i.test(text)) {
    return await handleSlashCommand('/ssh-test', sshService, runtime, callback);
  }

  // /ssh <target> <command>
  const sshMatch = text.match(/^\/ssh\s+(\S+)\s+(.+)/s);
  if (sshMatch) {
    const targetName = sshMatch[1];
    const command = sshMatch[2].trim();
    const target = sshService.getTarget(targetName);
    if (!target) {
      const available = [...sshService.getTargets().keys()].join(', ') || '(none)';
      if (callback) await callback({ text: `Unknown target "${targetName}". Available: ${available}` });
      return { success: false, error: `Unknown target: ${targetName}` };
    }
    if (callback) await callback({ text: `Running on ${targetName}...` });
    const result = await sshService.exec(targetName, command, 60_000);
    const output = result.stdout || result.stderr || '(no output)';
    const truncated = output.length > 3000 ? output.substring(output.length - 3000) : output;
    if (callback) {
      await callback({ text: `${result.success ? 'OK' : 'ERROR'} (exit ${result.code}):\n\`\`\`\n${truncated}\n\`\`\`` });
    }
    return { success: result.success, data: { code: result.code, output: truncated } as Record<string, unknown> };
  }

  // Determine default target
  const defaultTarget = sshService.getTarget('coolify')
    ? 'coolify' : [...sshService.getTargets().keys()][0];
  if (!defaultTarget) {
    if (callback) await callback({ text: 'No SSH targets configured.' });
    return { success: false, error: 'No SSH targets' };
  }

  // /deploy
  if (text.startsWith('/deploy')) {
    const targetName = text.replace('/deploy', '').trim() || defaultTarget;
    if (callback) await callback({ text: `Triggering deploy on ${targetName}...` });
    let result = await sshService.exec(targetName, 'cd /data/coolify && docker compose pull && docker compose up -d', 120_000);
    if (!result.success) {
      result = await sshService.exec(targetName, 'docker ps --format "{{.Names}}" | grep -i eliza | head -1 | xargs -r docker restart', 60_000);
    }
    const output = result.stdout || result.stderr || '(no output)';
    if (callback) await callback({ text: `Deploy ${result.success ? 'succeeded' : 'failed'}:\n\`\`\`\n${output.substring(0, 2000)}\n\`\`\`` });
    return { success: result.success, data: result as unknown as Record<string, unknown> };
  }

  // /logs
  if (text.startsWith('/logs')) {
    const parts = text.replace('/logs', '').trim().split(/\s+/);
    const targetName = sshService.getTarget(parts[0] || '') ? parts[0] : defaultTarget;
    const lines = parseInt(parts[parts.length - 1], 10) || 50;
    if (callback) await callback({ text: `Fetching last ${lines} log lines from ${targetName}...` });
    let result = await sshService.exec(targetName, `docker ps --format "{{.Names}}" | grep -i eliza | head -1 | xargs -r docker logs --tail ${lines}`, 30_000);
    if (!result.success || (!result.stdout && !result.stderr)) {
      result = await sshService.exec(targetName, `docker compose logs --tail ${lines} 2>&1 | tail -${lines}`, 30_000);
    }
    const output = result.stdout || result.stderr || '(no output)';
    const truncated = output.length > 3000 ? output.substring(output.length - 3000) : output;
    if (callback) await callback({ text: `\`\`\`\n${truncated}\n\`\`\`` });
    return { success: result.success, data: { output: truncated } };
  }

  // /containers
  if (text.startsWith('/containers')) {
    const targetName = text.replace('/containers', '').trim() || defaultTarget;
    const result = await sshService.exec(targetName, 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}"');
    const output = result.stdout || '(no containers)';
    if (callback) await callback({ text: `Containers on ${targetName}:\n\`\`\`\n${output.substring(0, 3000)}\n\`\`\`` });
    return { success: result.success, data: { output } as Record<string, unknown> };
  }

  // /restart-bot
  if (text.startsWith('/restart-bot') || text.startsWith('/restart_bot')) {
    const targetName = text.replace(/\/restart[-_]bot/, '').trim() || defaultTarget;
    if (callback) await callback({ text: `Restarting bot on ${targetName}...` });
    const result = await sshService.exec(targetName, 'docker ps --format "{{.Names}}" | grep -i eliza | head -1 | xargs -r docker restart', 60_000);
    if (callback) {
      const output = result.stdout || result.stderr || '(no output)';
      await callback({ text: `Restart ${result.success ? 'succeeded' : 'failed'}: ${output.substring(0, 500)}` });
    }
    return { success: result.success, data: result as unknown as Record<string, unknown> };
  }

  // Fallback help
  if (callback) {
    await callback({
      text: 'Available commands:\n- `/ssh <target> <command>` — run command\n- `/ssh targets` — list SSH targets\n- `/ssh test` — test connectivity\n- `/ops deploy` — redeploy bot\n- `/ops update` — pull latest code & rebuild\n- `/ops logs [lines]` — view logs\n- `/ops containers` — list containers\n- `/ops restart` — restart bot\n\nOr just say things naturally: "check the mac", "why is the server failing"',
    });
  }
  return { success: true };
}

// ── Self-update via Coolify API ────────────────────────────────────
async function handleSelfUpdate(
  runtime: IAgentRuntime,
  sshService: SSHService,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  if (callback) await callback({ text: 'Pulling latest code and triggering rebuild...' });

  const coolifyApiToken = String(runtime.getSetting('COOLIFY_API_TOKEN') || '3|coolify-bot-token-2026');
  const coolifyAppUuid = String(runtime.getSetting('COOLIFY_RESOURCE_UUID') || 'swoo0o4okwk8ocww4g4ks084');

  const curlCmd = `curl -s -X POST "http://localhost:8000/api/v1/applications/${coolifyAppUuid}/restart" -H "Authorization: Bearer ${coolifyApiToken}"`;

  const target = sshService.getTarget('coolify');
  if (!target) {
    if (callback) await callback({ text: 'No "coolify" SSH target configured. Cannot self-update.' });
    return { success: false, error: 'No coolify target' };
  }

  const result = await sshService.exec('coolify', curlCmd, 30_000);
  const output = result.stdout || result.stderr || '(no output)';

  try {
    const parsed = JSON.parse(output);
    if (parsed.message && parsed.deployment_uuid) {
      if (callback) await callback({
        text: `Update triggered. Deploy ID: ${parsed.deployment_uuid}\nI will restart with the latest code shortly.`,
      });
      return { success: true, data: { deployment_uuid: parsed.deployment_uuid } };
    }
    if (callback) await callback({ text: `Coolify response: ${output.substring(0, 500)}` });
    return { success: !parsed.error, data: parsed };
  } catch {
    if (callback) await callback({ text: `Update response:\n\`\`\`\n${output.substring(0, 1000)}\n\`\`\`` });
    return { success: result.success, data: { output } };
  }
}
