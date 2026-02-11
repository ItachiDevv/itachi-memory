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

export async function claimNextTask(projectFilter?: string, machineId?: string): Promise<Task | null> {
    const sb = getSupabase();
    const rpcParams: Record<string, unknown> = {
        p_orchestrator_id: config.orchestratorId,
    };
    if (machineId) {
        rpcParams.p_machine_id = machineId;
    }
    if (projectFilter) {
        rpcParams.p_project = projectFilter;
    }
    console.log(`[poll] RPC params:`, JSON.stringify(rpcParams));
    const { data, error } = await sb.rpc('claim_next_task', rpcParams);
    console.log(`[poll] RPC result: error=${error?.message || 'none'}, rows=${data?.length ?? 'null'}`);

    if (error) {
        console.error('[poll] Error claiming task:', error.message, error.details, error.hint);
        return null;
    }

    if (!data || data.length === 0) return null;
    console.log(`[poll] Claimed task ${(data[0] as Task).id.substring(0, 8)}`);
    return data[0] as Task;
}

export async function updateTask(taskId: string, updates: TaskUpdate): Promise<void> {
    const sb = getSupabase();
    const { error } = await sb
        .from('itachi_tasks')
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
        .from('itachi_tasks')
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
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (process.env.ITACHI_API_KEY) headers['Authorization'] = `Bearer ${process.env.ITACHI_API_KEY}`;
        const response = await fetch(`${config.apiUrl}/api/tasks/${taskId}/notify`, {
            method: 'POST',
            headers,
        });
        if (!response.ok) {
            console.error(`Notify failed for task ${taskId}: ${response.statusText}`);
        }
    } catch (err) {
        console.error(`Notify error for task ${taskId}:`, err);
    }
}
