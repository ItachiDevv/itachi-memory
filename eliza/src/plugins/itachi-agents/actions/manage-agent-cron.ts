import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { AgentCronService } from '../services/agent-cron-service.js';
import { AgentProfileService } from '../services/agent-profile-service.js';

export const manageAgentCronAction: Action = {
  name: 'MANAGE_AGENT_CRON',
  description: 'Schedule, list, or cancel recurring agent tasks using cron expressions. Use when the user wants to set up automated recurring work.',
  similes: [
    'schedule a',
    'every hour',
    'every morning',
    'recurring task',
    'cron job',
    'cancel schedule',
    'list schedules',
    'show cron jobs',
  ],

  examples: [
    [
      { name: 'user', content: { text: 'schedule a health check every 30 minutes using devops' } },
      {
        name: 'Assistant',
        content: { text: 'Created cron job: devops health check every 30 minutes (*/30 * * * *)' },
      },
    ],
    [
      { name: 'user', content: { text: 'list scheduled jobs' } },
      {
        name: 'Assistant',
        content: { text: '## Scheduled Jobs\n1. DevOps health check — */30 * * * * (12 runs)\n2. PR review — 0 9 * * 1-5 (3 runs)' },
      },
    ],
    [
      { name: 'user', content: { text: 'cancel the health check cron' } },
      {
        name: 'Assistant',
        content: { text: 'Cancelled the health check cron job.' },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = runtime.getService('itachi-agent-cron') as AgentCronService | undefined;
    return !!service;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = message.content?.text || '';
    const cronService = runtime.getService('itachi-agent-cron') as AgentCronService | undefined;
    const profileService = runtime.getService('itachi-agent-profiles') as AgentProfileService | undefined;

    if (!cronService) return { success: false, error: 'AgentCronService not available' };

    // Determine intent
    if (/\b(list|show|display)\b.*\b(schedule|cron|job|recurring)\b/i.test(text)) {
      return await handleList(cronService, profileService, callback);
    }

    if (/\b(cancel|stop|disable|delete|remove)\b.*\b(schedule|cron|job)\b/i.test(text)) {
      return await handleCancel(runtime, text, cronService, profileService, callback);
    }

    // Default: create a new cron job
    return await handleCreate(runtime, text, cronService, profileService, callback);
  },
};

async function handleList(
  cronService: AgentCronService,
  profileService: AgentProfileService | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const jobs = await cronService.listJobs(false);

  if (jobs.length === 0) {
    if (callback) await callback({ text: 'No scheduled cron jobs. Use "schedule [task] every [interval] using [profile]" to create one.' });
    return { success: true, data: { count: 0 } };
  }

  const profiles = profileService ? await profileService.listProfiles() : [];
  const profileMap = new Map(profiles.map((p) => [p.id, p.display_name]));

  let text = '## Scheduled Jobs\n';
  for (const job of jobs) {
    const name = job.agent_profile_id ? (profileMap.get(job.agent_profile_id) || job.agent_profile_id) : 'main';
    const status = job.enabled ? 'active' : 'disabled';
    text += `- **${name}**: ${job.task_description.slice(0, 80)} — \`${job.schedule}\` (${job.run_count} runs, ${status})\n`;
    text += `  ID: \`${job.id.slice(0, 8)}\`\n`;
  }

  if (callback) await callback({ text });
  return { success: true, data: { count: jobs.length } };
}

async function handleCancel(
  runtime: IAgentRuntime,
  text: string,
  cronService: AgentCronService,
  profileService: AgentProfileService | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const jobs = await cronService.listJobs(false);
  if (jobs.length === 0) {
    if (callback) await callback({ text: 'No cron jobs to cancel.' });
    return { success: true };
  }

  // Try to match by ID prefix
  const idMatch = text.match(/\b([0-9a-f]{8})/i);
  if (idMatch) {
    const prefix = idMatch[1].toLowerCase();
    const job = jobs.find((j) => j.id.startsWith(prefix));
    if (job) {
      await cronService.cancelJob(job.id);
      if (callback) await callback({ text: `Cancelled cron job: ${job.task_description.slice(0, 80)}` });
      return { success: true, data: { jobId: job.id } };
    }
  }

  // Try to match by description keywords using LLM
  try {
    const jobList = jobs.map((j, i) => `${i}: ${j.task_description} (${j.schedule})`).join('\n');
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `Which job should be cancelled? User said: "${text}"\n\nJobs:\n${jobList}\n\nRespond with just the index number.`,
      temperature: 0,
    });

    const idx = parseInt(typeof response === 'string' ? response.trim() : '');
    if (!isNaN(idx) && idx >= 0 && idx < jobs.length) {
      await cronService.cancelJob(jobs[idx].id);
      if (callback) await callback({ text: `Cancelled cron job: ${jobs[idx].task_description.slice(0, 80)}` });
      return { success: true, data: { jobId: jobs[idx].id } };
    }
  } catch { /* ignore */ }

  if (callback) await callback({ text: 'Could not determine which job to cancel. Use "list schedules" to see job IDs, then "cancel cron [id]".' });
  return { success: false, error: 'Could not match job' };
}

async function handleCreate(
  runtime: IAgentRuntime,
  text: string,
  cronService: AgentCronService,
  profileService: AgentProfileService | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  // Use LLM to extract schedule, profile, and task
  const profiles = profileService ? await profileService.listProfiles() : [];
  const profileList = profiles.map((p) => p.id).join(', ');

  try {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `Extract a cron job definition from this request.
Available agent profiles: ${profileList || 'none'}

Request: "${text}"

Respond in JSON:
{
  "schedule": "cron expression (5 fields)",
  "profileId": "profile-id or null",
  "taskDescription": "what the job should do"
}

Common patterns:
- "every 30 minutes" = "*/30 * * * *"
- "every hour" = "0 * * * *"
- "every morning at 9am" = "0 9 * * *"
- "every weekday at 9am" = "0 9 * * 1-5"
- "daily at midnight" = "0 0 * * *"`,
      temperature: 0,
    });

    const parsed = JSON.parse(typeof response === 'string' ? response : '{}');
    if (!parsed.schedule || !parsed.taskDescription) {
      if (callback) await callback({ text: 'Could not parse a cron schedule from your request. Try: "schedule [task] every [interval] using [profile]"' });
      return { success: false, error: 'Parse failed' };
    }

    const job = await cronService.createJob({
      profileId: parsed.profileId || undefined,
      schedule: parsed.schedule,
      taskDescription: parsed.taskDescription,
    });

    if (!job) {
      if (callback) await callback({ text: 'Failed to create cron job. The cron expression may be invalid.' });
      return { success: false, error: 'Create failed' };
    }

    const profileName = parsed.profileId
      ? (profiles.find((p) => p.id === parsed.profileId)?.display_name || parsed.profileId)
      : 'main agent';

    if (callback) {
      await callback({
        text: `Created cron job for **${profileName}**: ${parsed.taskDescription}\nSchedule: \`${parsed.schedule}\`\nNext run: ${job.next_run_at || 'calculating...'}`,
      });
    }

    return { success: true, data: { jobId: job.id, schedule: parsed.schedule } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (callback) await callback({ text: `Error creating cron job: ${msg}` });
    return { success: false, error: msg };
  }
}
