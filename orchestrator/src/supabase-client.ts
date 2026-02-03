import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';
import type { Task, TaskUpdate } from './types';

let supabase: SupabaseClient;

export function getSupabase(): SupabaseClient {
    if (!supabase) {
        supabase = createClient(config.supabaseUrl, config.supabaseKey);
    }
    return supabase;
}

export async function claimNextTask(): Promise<Task | null> {
    const sb = getSupabase();
    const { data, error } = await sb.rpc('claim_next_task', {
        p_orchestrator_id: config.orchestratorId,
    });

    if (error) {
        console.error('Error claiming task:', error.message);
        return null;
    }

    if (!data || data.length === 0) return null;
    return data[0] as Task;
}

export async function updateTask(taskId: string, updates: TaskUpdate): Promise<void> {
    const sb = getSupabase();
    const { error } = await sb
        .from('tasks')
        .update(updates)
        .eq('id', taskId);

    if (error) {
        console.error(`Error updating task ${taskId}:`, error.message);
    }
}

export async function recoverStuckTasks(): Promise<number> {
    const sb = getSupabase();

    // Find tasks stuck as 'running' or 'claimed' by this orchestrator
    const { data, error } = await sb
        .from('tasks')
        .select('id')
        .eq('orchestrator_id', config.orchestratorId)
        .in('status', ['running', 'claimed']);

    if (error || !data) return 0;

    for (const task of data) {
        await updateTask(task.id, {
            status: 'failed',
            error_message: `Recovered on orchestrator restart (was stuck)`,
            completed_at: new Date().toISOString(),
        });
    }

    return data.length;
}

export async function notifyTaskCompletion(taskId: string): Promise<void> {
    try {
        const response = await fetch(`${config.apiUrl}/api/tasks/${taskId}/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) {
            console.error(`Notify failed for task ${taskId}: ${response.statusText}`);
        }
    } catch (err) {
        console.error(`Notify error for task ${taskId}:`, err);
    }
}
