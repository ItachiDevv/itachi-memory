import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { SSHService } from '../services/ssh-service.js';

/**
 * Coolify/SSH control action. Gives the Telegram bot full control over
 * remote machines via SSH (typically the Coolify VPS via Tailscale).
 *
 * Commands:
 *   /ssh <target> <command>        — run arbitrary command
 *   /deploy [target]               — redeploy the bot container
 *   /logs [target] [lines]         — tail container logs
 *   /containers [target]           — list running containers
 *   /restart-bot [target]          — restart the ElizaOS container
 *   /ssh-targets                   — list configured SSH targets
 */
export const coolifyControlAction: Action = {
  name: 'COOLIFY_CONTROL',
  description: 'Control remote servers via SSH. Use for /ssh, /deploy, /logs, /containers, /restart-bot, /ssh-targets commands.',
  similes: ['ssh command', 'deploy bot', 'view logs', 'restart bot', 'list containers', 'server control'],
  examples: [
    [
      { name: 'user', content: { text: '/ssh coolify docker ps' } },
      { name: 'Itachi', content: { text: '```\nCONTAINER ID  IMAGE       STATUS      NAMES\nabc123       eliza:latest Up 2 hours  eliza-bot\n```' } },
    ],
    [
      { name: 'user', content: { text: '/logs' } },
      { name: 'Itachi', content: { text: 'Last 50 lines from eliza-bot:\n```\n[info] Server started on port 3000\n...\n```' } },
    ],
    [
      { name: 'user', content: { text: '/ssh-targets' } },
      { name: 'Itachi', content: { text: 'Configured SSH targets:\n- coolify (root@100.x.x.x)\n- mac (itachisan@100.x.x.x)' } },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text || '';
    if (/^\/(ssh|deploy|logs|containers|restart-bot|ssh-targets)\b/.test(text)) return true;
    const sshService = runtime.getService<SSHService>('ssh');
    return !!sshService;
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

      const text = message.content?.text || '';

      // /ssh-targets — list all configured targets
      if (text.startsWith('/ssh-targets')) {
        const targets = sshService.getTargets();
        if (targets.size === 0) {
          if (callback) await callback({ text: 'No SSH targets configured. Set COOLIFY_SSH_HOST or ITACHI_SSH_<NAME>_HOST env vars.' });
          return { success: true, data: { targets: [] } };
        }
        const lines = [...targets.entries()].map(([name, t]) => `- **${name}**: ${t.user}@${t.host}:${t.port || 22}`);
        if (callback) await callback({ text: `Configured SSH targets:\n${lines.join('\n')}` });
        return { success: true, data: { targets: [...targets.keys()] } };
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
          await callback({
            text: `${result.success ? 'OK' : 'ERROR'} (exit ${result.code}):\n\`\`\`\n${truncated}\n\`\`\``,
          });
        }
        return { success: result.success, data: { code: result.code, output: truncated } as Record<string, unknown> };
      }

      // Determine default target (coolify, or first available)
      const defaultTarget = sshService.getTarget('coolify')
        ? 'coolify'
        : [...sshService.getTargets().keys()][0];

      if (!defaultTarget) {
        if (callback) await callback({ text: 'No SSH targets configured.' });
        return { success: false, error: 'No SSH targets' };
      }

      // /deploy [target]
      if (text.startsWith('/deploy')) {
        const targetName = text.replace('/deploy', '').trim() || defaultTarget;
        if (callback) await callback({ text: `Triggering deploy on ${targetName}...` });

        // Try docker compose pull + up first, fall back to docker restart
        let result = await sshService.exec(targetName, 'cd /data/coolify && docker compose pull && docker compose up -d', 120_000);
        if (!result.success) {
          // Fallback: find and restart the eliza container
          result = await sshService.exec(targetName, 'docker ps --format "{{.Names}}" | grep -i eliza | head -1 | xargs -r docker restart', 60_000);
        }

        const output = result.stdout || result.stderr || '(no output)';
        if (callback) {
          await callback({ text: `Deploy ${result.success ? 'succeeded' : 'failed'}:\n\`\`\`\n${output.substring(0, 2000)}\n\`\`\`` });
        }
        return { success: result.success, data: result as unknown as Record<string, unknown> };
      }

      // /logs [target] [lines]
      if (text.startsWith('/logs')) {
        const parts = text.replace('/logs', '').trim().split(/\s+/);
        const targetName = sshService.getTarget(parts[0] || '') ? parts[0] : defaultTarget;
        const lines = parseInt(parts[parts.length - 1], 10) || 50;

        if (callback) await callback({ text: `Fetching last ${lines} log lines from ${targetName}...` });

        // Try docker compose logs, fall back to docker logs
        let result = await sshService.exec(targetName, `docker ps --format "{{.Names}}" | grep -i eliza | head -1 | xargs -r docker logs --tail ${lines}`, 30_000);
        if (!result.success || (!result.stdout && !result.stderr)) {
          result = await sshService.exec(targetName, `docker compose logs --tail ${lines} 2>&1 | tail -${lines}`, 30_000);
        }

        const output = result.stdout || result.stderr || '(no output)';
        const truncated = output.length > 3000 ? output.substring(output.length - 3000) : output;
        if (callback) {
          await callback({ text: `\`\`\`\n${truncated}\n\`\`\`` });
        }
        return { success: result.success, data: { output: truncated } };
      }

      // /containers [target]
      if (text.startsWith('/containers')) {
        const targetName = text.replace('/containers', '').trim() || defaultTarget;
        const result = await sshService.exec(targetName, 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}"');

        const output = result.stdout || '(no containers)';
        if (callback) {
          await callback({ text: `Containers on ${targetName}:\n\`\`\`\n${output.substring(0, 3000)}\n\`\`\`` });
        }
        return { success: result.success, data: { output } as Record<string, unknown> };
      }

      // /restart-bot [target]
      if (text.startsWith('/restart-bot')) {
        const targetName = text.replace('/restart-bot', '').trim() || defaultTarget;
        if (callback) await callback({ text: `Restarting bot on ${targetName}...` });

        const result = await sshService.exec(targetName, 'docker ps --format "{{.Names}}" | grep -i eliza | head -1 | xargs -r docker restart', 60_000);

        if (callback) {
          const output = result.stdout || result.stderr || '(no output)';
          await callback({ text: `Restart ${result.success ? 'succeeded' : 'failed'}: ${output.substring(0, 500)}` });
        }
        return { success: result.success, data: result as unknown as Record<string, unknown> };
      }

      // Fallback
      if (callback) {
        await callback({
          text: 'Available commands:\n- `/ssh <target> <command>` — run command\n- `/deploy` — redeploy bot\n- `/logs [lines]` — view logs\n- `/containers` — list containers\n- `/restart-bot` — restart bot\n- `/ssh-targets` — list targets',
        });
      }
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (callback) await callback({ text: `SSH error: ${msg}` });
      return { success: false, error: msg };
    }
  },
};
