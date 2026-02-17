import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import type { ItachiTask } from '../services/task-service.js';
import { TaskService, generateTaskTitle } from '../services/task-service.js';
import { stripBotMention } from '../utils/telegram.js';

/** Format a single task into a readable Telegram message */
function formatTaskDetail(task: ItachiTask): string {
  const shortId = task.id.substring(0, 8);
  const fmtDate = (d?: string) => d ? new Date(d).toISOString().replace('T', ' ').substring(0, 16) + ' UTC' : null;
  const lines: string[] = [
    `Task ${shortId}:`,
    '',
    `Status: ${task.status}`,
    `Project: ${task.project}`,
    `Description: ${task.description.substring(0, 200)}`,
    `Machine: ${task.assigned_machine || 'unassigned'}`,
  ];
  if (task.pr_url) lines.push(`PR: ${task.pr_url}`);
  if (task.result_summary) lines.push(`Result: ${task.result_summary}`);
  if (task.error_message) lines.push(`Error: ${task.error_message}`);
  if (task.files_changed?.length) lines.push(`Files: ${task.files_changed.join(', ')}`);
  const created = fmtDate(task.created_at);
  if (created) lines.push(`Created: ${created}`);
  const started = fmtDate(task.started_at);
  if (started) lines.push(`Started: ${started}`);
  const completed = fmtDate(task.completed_at);
  if (completed) lines.push(`Completed: ${completed}`);
  return lines.join('\n');
}

export const listTasksAction: Action = {
  name: 'LIST_TASKS',
  description: 'List recent or active tasks, or look up a specific task by ID',
  similes: ['show tasks', 'task status', 'what tasks', 'queue status', 'running tasks', 'progress', 'check on task', 'what happened to task'],
  examples: [
    [
      { name: 'user', content: { text: 'What tasks are running?' } },
      {
        name: 'Itachi',
        content: {
          text: 'Active queue (2 tasks):\n\n1. [running] a1b2c3d4 | my-app: Fix the login bug | machine:windows-pc\n2. [queued] e5f6g7h8 | api-service: Add pagination | machine:unassigned',
        },
      },
    ],
    [
      { name: 'user', content: { text: 'What happened to task aa8f6720?' } },
      {
        name: 'Itachi',
        content: {
          text: 'Task aa8f6720:\n\nStatus: completed\nProject: gudtek\nDescription: Setup Android packaging\nMachine: windows-pc\nResult: Build configured and tested successfully\nCompleted: 2026-02-09 05:30 UTC',
        },
      },
    ],
    [
      { name: 'user', content: { text: '/status aa8f6720' } },
      {
        name: 'Itachi',
        content: {
          text: 'Task aa8f6720:\n\nStatus: queued\nProject: gudtek\nDescription: Setup the gudtek repo for app packaging\nMachine: unassigned\nCreated: 2026-02-09 04:14 UTC',
        },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = stripBotMention(message.content?.text?.toLowerCase() || '');
    if (text.startsWith('/status')) return true;

    // Direct keyword matches
    if (
      text.includes('task') ||
      text.includes('queue') ||
      text.includes('status') ||
      text.includes('running') ||
      text.includes('progress') ||
      text.includes('check on') ||
      text.includes('what\'s happening') ||
      text.includes('details on') ||
      text.includes('update on')
    ) return true;

    // Natural language patterns: "did it finish?", "is it done?", "what happened to..."
    if (text.includes('what happened')) return true;
    if (text.includes('any updates')) return true;
    if (/\b(did|has)\b.*\b(finish|complete|succeed|fail|work|done)\b/.test(text)) return true;
    if (/\b(is|are)\b.*\b(done|finished|completed|still|ready)\b/.test(text)) return true;
    if (/\b(how|what).*(going|doing)\b/.test(text)) return true;

    // Task ID pattern (6-8 hex chars) in the message — likely asking about a specific task
    if (/\b[0-9a-f]{6,8}\b/.test(text)) return true;

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
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      if (!taskService) {
        callback?.({ text: 'Task service is not available right now.' });
        return { success: false, error: 'Task service not available' };
      }

      const text = stripBotMention(message.content?.text || '');
      const textLower = text.toLowerCase();

      // --- Specific task ID lookup (highest priority) ---
      // Match /status <id> or bare hex ID anywhere in the message
      const statusMatch = text.match(/\/status\s+(\S+)/);
      let taskPrefix = statusMatch?.[1];
      if (!taskPrefix) {
        const hexMatch = textLower.match(/\b([0-9a-f]{6,8})\b/);
        if (hexMatch) taskPrefix = hexMatch[1];
      }

      if (taskPrefix) {
        const task = await taskService.getTaskByPrefix(taskPrefix);
        if (!task) {
          callback?.({ text: `Task "${taskPrefix}" not found in the database.` });
          return { success: false, error: 'Task not found' };
        }
        callback?.({ text: formatTaskDetail(task) });
        return { success: true, data: { task } };
      }

      // --- General active/queue query ---
      // For active queue queries, the activeTasksProvider already has the data in LLM context,
      // so don't callback to avoid duplicate responses. The LLM can format from provider data.
      const isQueueQuery = textLower.includes('queue') || textLower.includes('running') || textLower.includes('active');
      if (isQueueQuery) {
        const tasks = await taskService.getActiveTasks();
        // No callback — LLM answers from provider context
        return { success: true, data: { tasks } };
      }

      // --- Default: list recent tasks ---
      const tasks = await taskService.listTasks({ limit: 5 });
      if (tasks.length === 0) {
        // No callback — LLM can say "no recent tasks"
        return { success: true, data: { tasks: [] } };
      }
      const lines: string[] = [`Recent tasks (${tasks.length}):\n`];
      for (const t of tasks) {
        const id = t.id.substring(0, 8);
        const title = generateTaskTitle(t.description);
        const summary = t.result_summary ? ` — ${t.result_summary.substring(0, 60)}` : '';
        const pr = t.pr_url ? ` PR: ${t.pr_url}` : '';
        lines.push(`[${t.status}] ${id} | ${t.project}: ${title}${summary}${pr}`);
      }
      callback?.({ text: lines.join('\n') });
      return { success: true, data: { tasks } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      callback?.({ text: `Failed to look up tasks: ${msg}` });
      return { success: false, error: msg };
    }
  },
};
