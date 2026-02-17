import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { SSHService } from '../services/ssh-service.js';
import { stripBotMention } from '../utils/telegram.js';

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
 * Detect the primary intent from natural language.
 */
function detectIntent(text: string): string {
  for (const [intent, pattern] of Object.entries(INTENTS)) {
    if (pattern.test(text)) return intent;
  }
  return 'investigate'; // Default: investigate
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

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = stripBotMention(message.content?.text || '');
    // Always match explicit slash commands
    if (/^\/(ssh|deploy|update|logs|containers|restart[-_]bot|ssh[-_]targets|ssh[-_]test)\b/.test(text)) return true;
    // Match natural language about machines/servers
    const lower = text.toLowerCase();
    const mentionsMachine = Object.keys(MACHINE_ALIASES).some(alias => lower.includes(alias));
    const mentionsAction = /\b(ssh|check|investigate|deploy|restart|update|logs?|status|failing|broken|down|running|containers?|docker|fix|diagnose|debug|figure out)\b/i.test(text);
    if (mentionsMachine && mentionsAction) return true;
    // Match if they mention SSH explicitly
    if (/\bssh\b/i.test(text)) return true;
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
      const target = extractTarget(text, sshService);
      const intent = detectIntent(text);

      if (!target) {
        // No machine identified — list available targets
        const available = [...sshService.getTargets().keys()].join(', ');
        if (callback) await callback({
          text: `Which machine? Available targets: ${available}\n\nYou can say things like "check the mac" or "ssh into windows and run docker ps"`,
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

        default: {
          // investigate, status, logs, disk, containers — run diagnostics
          const diagSteps = DIAGNOSTICS[intent] || DIAGNOSTICS.investigate;
          if (callback) await callback({ text: `Investigating ${target}...` });
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
      text: 'Available commands:\n- `/ssh <target> <command>` — run command\n- `/deploy` — redeploy bot\n- `/update` — pull latest code & rebuild\n- `/logs [lines]` — view logs\n- `/containers` — list containers\n- `/restart-bot` — restart bot\n- `/ssh-targets` — list targets\n- `/ssh-test` — test connectivity to all targets\n\nOr just say things naturally: "check the mac", "why is the server failing"',
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
