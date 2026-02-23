import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { MachineRegistryService } from '../services/machine-registry.js';
import { stripBotMention, getTopicThreadId } from '../utils/telegram.js';
import { activeSessions } from '../shared/active-sessions.js';
import { browsingSessionMap } from '../utils/directory-browser.js';

export const remoteExecAction: Action = {
  name: 'REMOTE_EXEC',
  description: 'Run an allowlisted command on a remote orchestrator machine. Use when the user asks to check status, pull updates, or restart a machine.',
  similes: ['run command on machine', 'check machine status', 'pull on machine', 'restart machine'],
  examples: [
    [
      { name: 'user', content: { text: '/exec @air git status' } },
      {
        name: 'Itachi',
        content: {
          text: 'Running `git status` on air...\n\nOn branch master\nnothing to commit, working tree clean',
        },
      },
    ],
    [
      { name: 'user', content: { text: 'check status of air' } },
      {
        name: 'Itachi',
        content: {
          text: 'Machine air status:\n- Active tasks: 1\n- Engines: claude → gemini\n- Uptime: 3600s',
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (message.content?.source === 'telegram') {
      const threadId = await getTopicThreadId(runtime, message);
      if (threadId !== null && (activeSessions.has(threadId) || browsingSessionMap.has(threadId))) return false;
    }
    const text = stripBotMention(message.content?.text || '');
    // Explicit slash commands
    if (text.startsWith('/exec ')) return true;
    if (text.startsWith('/pull ')) return true;
    if (text.startsWith('/restart ')) return true;
    // Natural language: require BOTH a machine mention AND an action keyword
    const registry = runtime.getService<MachineRegistryService>('machine-registry');
    if (!registry) return false;
    const machines = await registry.getAllMachines();
    const machineNames = machines.flatMap(m => [m.machine_id, m.display_name || ''].filter(Boolean).map(n => n.toLowerCase()));
    const lower = text.toLowerCase();
    const mentionsMachine = machineNames.some(name => lower.includes(name)) || lower.includes('@');
    const mentionsAction = /\b(status|check|pull|restart|exec|run command|uptime)\b/i.test(text);
    return mentionsMachine && mentionsAction;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const registry = runtime.getService<MachineRegistryService>('machine-registry');
      if (!registry) {
        return { success: false, error: 'Machine registry service not available' };
      }

      const text = stripBotMention(message.content?.text || '');
      const apiKey = runtime.getSetting('ITACHI_API_KEY');

      // Parse: /exec @machine command  OR  /pull @machine  OR  /restart @machine
      let machineInput: string | undefined;
      let action: 'exec' | 'pull' | 'restart' | 'status' = 'status';
      let command: string | undefined;

      const execMatch = text.match(/^\/exec\s+@(\S+)\s+(.+)/s);
      const pullMatch = text.match(/^\/pull\s+@(\S+)/);
      const restartMatch = text.match(/^\/restart\s+@(\S+)/);

      if (execMatch) {
        machineInput = execMatch[1];
        action = 'exec';
        command = execMatch[2].trim();
      } else if (pullMatch) {
        machineInput = pullMatch[1];
        action = 'pull';
      } else if (restartMatch) {
        machineInput = restartMatch[1];
        action = 'restart';
      } else {
        // Try NL: "check status of air", "pull on air", etc.
        const statusMatch = text.match(/(?:status|check)\s+(?:of\s+)?(\S+)/i);
        const nlPullMatch = text.match(/pull\s+(?:on\s+)?(\S+)/i);
        const nlRestartMatch = text.match(/restart\s+(\S+)/i);
        if (statusMatch) {
          machineInput = statusMatch[1];
          action = 'status';
        } else if (nlPullMatch) {
          machineInput = nlPullMatch[1];
          action = 'pull';
        } else if (nlRestartMatch) {
          machineInput = nlRestartMatch[1];
          action = 'restart';
        }
      }

      if (!machineInput) {
        if (callback) await callback({ text: 'Usage: /exec @machine <command>, /pull @machine, /restart @machine' });
        return { success: false, error: 'No machine specified' };
      }

      // Resolve machine
      const { machine } = await registry.resolveMachine(machineInput);
      if (!machine) {
        if (callback) await callback({ text: `Machine "${machineInput}" not found.` });
        return { success: false, error: 'Machine not found' };
      }
      if (!machine.health_url) {
        if (callback) await callback({ text: `Machine "${machine.display_name || machine.machine_id}" has no health_url registered.` });
        return { success: false, error: 'No health_url' };
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const machineName = machine.display_name || machine.machine_id;

      if (action === 'status') {
        const res = await fetch(`${machine.health_url}/status`, { headers });
        if (!res.ok) {
          if (callback) await callback({ text: `Failed to reach ${machineName}: ${res.status}` });
          return { success: false, error: `Status check failed: ${res.status}` };
        }
        const data = await res.json() as Record<string, unknown>;
        const lines = Object.entries(data).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
        if (callback) await callback({ text: `Machine ${machineName} status:\n${lines.join('\n')}` });
        return { success: true, data };
      }

      if (action === 'exec') {
        if (callback) await callback({ text: `Running \`${command}\` on ${machineName}...` });
        const res = await fetch(`${machine.health_url}/exec`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ command }),
        });
        const data = await res.json() as { success?: boolean; output?: string; error?: string };
        if (callback) {
          const output = data.output || data.error || '(no output)';
          await callback({ text: `${data.success ? 'OK' : 'ERROR'}:\n\`\`\`\n${output.substring(0, 1000)}\n\`\`\`` });
        }
        return { success: !!data.success, data };
      }

      if (action === 'pull') {
        if (callback) await callback({ text: `Pulling & rebuilding on ${machineName}...` });
        const res = await fetch(`${machine.health_url}/pull`, { method: 'POST', headers });
        const data = await res.json() as { success?: boolean; output?: string; error?: string };
        if (callback) {
          const output = data.output || data.error || '(no output)';
          await callback({ text: `Pull ${data.success ? 'succeeded' : 'failed'}:\n\`\`\`\n${output.substring(0, 1000)}\n\`\`\`` });
        }
        return { success: !!data.success, data };
      }

      if (action === 'restart') {
        if (callback) await callback({ text: `Requesting restart of ${machineName}...` });
        const res = await fetch(`${machine.health_url}/restart`, { method: 'POST', headers });
        const data = await res.json() as { success?: boolean; message?: string };
        if (callback) await callback({ text: data.message || 'Restart requested.' });
        return { success: true, data };
      }

      return { success: false, error: 'Unknown action' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (callback) await callback({ text: `Error: ${msg}` });
      return { success: false, error: msg };
    }
  },
};
