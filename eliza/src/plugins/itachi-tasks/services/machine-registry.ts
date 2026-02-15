import { Service, type IAgentRuntime } from '@elizaos/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface MachineRecord {
  machine_id: string;
  display_name: string | null;
  projects: string[];
  max_concurrent: number;
  active_tasks: number;
  os: string | null;
  specs: Record<string, unknown>;
  engine_priority: string[];
  health_url: string | null;
  last_heartbeat: string;
  registered_at: string;
  status: 'online' | 'offline' | 'busy';
}

export interface RegisterMachineParams {
  machine_id: string;
  display_name?: string;
  projects?: string[];
  max_concurrent?: number;
  os?: string;
  specs?: Record<string, unknown>;
  engine_priority?: string[];
  health_url?: string;
}

export class MachineRegistryService extends Service {
  static serviceType = 'machine-registry';
  capabilityDescription = 'Machine registry for orchestrator dispatch';

  private supabase: SupabaseClient;
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
    const url = runtime.getSetting('SUPABASE_URL');
    const key = runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY') || runtime.getSetting('SUPABASE_KEY');
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for MachineRegistryService');
    }
    this.supabase = createClient(url, key);
  }

  static async start(runtime: IAgentRuntime): Promise<MachineRegistryService> {
    const service = new MachineRegistryService(runtime);
    runtime.logger.info('MachineRegistryService started');
    return service;
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('MachineRegistryService stopped');
  }

  /**
   * Register or update a machine in the registry.
   */
  async registerMachine(params: RegisterMachineParams): Promise<MachineRecord> {
    const row: Record<string, unknown> = {
      machine_id: params.machine_id,
      last_heartbeat: new Date().toISOString(),
      status: 'online',
    };
    if (params.display_name !== undefined) row.display_name = params.display_name;
    if (params.projects !== undefined) row.projects = params.projects;
    if (params.max_concurrent !== undefined) row.max_concurrent = params.max_concurrent;
    if (params.os !== undefined) row.os = params.os;
    if (params.specs !== undefined) row.specs = params.specs;
    if (params.engine_priority !== undefined) row.engine_priority = params.engine_priority;
    if (params.health_url !== undefined) row.health_url = params.health_url;

    const { data, error } = await this.supabase
      .from('machine_registry')
      .upsert(row, { onConflict: 'machine_id' })
      .select()
      .single();

    if (error) throw new Error(error.message || JSON.stringify(error));
    return data as MachineRecord;
  }

  /**
   * Update heartbeat timestamp and active task count.
   */
  async heartbeat(machineId: string, activeTasks: number): Promise<MachineRecord> {
    const status = activeTasks > 0 ? 'busy' : 'online';
    const { data, error } = await this.supabase
      .from('machine_registry')
      .update({
        last_heartbeat: new Date().toISOString(),
        active_tasks: activeTasks,
        status,
      })
      .eq('machine_id', machineId)
      .select()
      .single();

    if (error) throw new Error(error.message || JSON.stringify(error));
    return data as MachineRecord;
  }

  /**
   * Get machines that are online and have capacity (active_tasks < max_concurrent).
   * Only includes machines with heartbeat within the last 60 seconds.
   */
  async getAvailableMachines(): Promise<MachineRecord[]> {
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const { data, error } = await this.supabase
      .from('machine_registry')
      .select('*')
      .in('status', ['online', 'busy'])
      .gte('last_heartbeat', cutoff);

    if (error) throw new Error(error.message || JSON.stringify(error));
    // Filter in JS: active_tasks < max_concurrent (Supabase can't do cross-column filter easily)
    return ((data as MachineRecord[]) || []).filter(m => m.active_tasks < m.max_concurrent);
  }

  /**
   * Find the best machine for a project:
   * 1) Machine with the project in its projects array AND has capacity
   * 2) Any machine with capacity
   * 3) null (no machine available)
   */
  async getMachineForProject(project: string): Promise<MachineRecord | null> {
    const available = await this.getAvailableMachines();
    if (available.length === 0) return null;

    // Prefer machine that has the project cloned
    const withProject = available.find(m =>
      m.projects.includes(project)
    );
    if (withProject) return withProject;

    // Fall back to machine with most free capacity
    available.sort((a, b) => (b.max_concurrent - b.active_tasks) - (a.max_concurrent - a.active_tasks));
    return available[0] || null;
  }

  /**
   * Assign a task to a specific machine.
   */
  async assignTask(taskId: string, machineId: string): Promise<void> {
    const { error } = await this.supabase
      .from('itachi_tasks')
      .update({ assigned_machine: machineId })
      .eq('id', taskId);

    if (error) throw new Error(error.message || JSON.stringify(error));
  }

  /**
   * Mark a machine as offline (stale heartbeat > 120s).
   */
  async markOffline(machineId: string): Promise<void> {
    const { error } = await this.supabase
      .from('machine_registry')
      .update({ status: 'offline' })
      .eq('machine_id', machineId);

    if (error) throw new Error(error.message || JSON.stringify(error));
  }

  /**
   * Get all machines regardless of status.
   */
  async getAllMachines(): Promise<MachineRecord[]> {
    const { data, error } = await this.supabase
      .from('machine_registry')
      .select('*')
      .order('registered_at', { ascending: false });

    if (error) throw new Error(error.message || JSON.stringify(error));
    return (data as MachineRecord[]) || [];
  }

  /**
   * Get a single machine by ID.
   */
  async getMachine(machineId: string): Promise<MachineRecord | null> {
    const { data, error } = await this.supabase
      .from('machine_registry')
      .select('*')
      .eq('machine_id', machineId)
      .single();

    if (error) return null;
    return data as MachineRecord;
  }

  /**
   * Find stale machines (heartbeat older than cutoffMs) and mark them offline.
   * Returns the IDs of machines marked offline.
   */
  async markStaleMachinesOffline(cutoffMs: number = 120_000): Promise<string[]> {
    const cutoff = new Date(Date.now() - cutoffMs).toISOString();
    const { data, error } = await this.supabase
      .from('machine_registry')
      .select('machine_id')
      .in('status', ['online', 'busy'])
      .lt('last_heartbeat', cutoff);

    if (error || !data || data.length === 0) return [];

    const staleIds = data.map((m: { machine_id: string }) => m.machine_id);

    // Mark them offline
    await this.supabase
      .from('machine_registry')
      .update({ status: 'offline' })
      .in('machine_id', staleIds);

    return staleIds;
  }

  /**
   * Resolve a machine from user input via fuzzy matching.
   * Priority: exact machine_id → exact display_name → substring display_name → substring machine_id
   */
  async resolveMachine(input: string): Promise<{ machine: MachineRecord | null; allMachines: MachineRecord[] }> {
    const allMachines = await this.getAllMachines();
    const lower = input.toLowerCase();

    // Exact machine_id
    let machine = allMachines.find(m => m.machine_id.toLowerCase() === lower) || null;
    if (machine) return { machine, allMachines };

    // Exact display_name
    machine = allMachines.find(m => m.display_name?.toLowerCase() === lower) || null;
    if (machine) return { machine, allMachines };

    // Substring display_name
    machine = allMachines.find(m => m.display_name?.toLowerCase().includes(lower)) || null;
    if (machine) return { machine, allMachines };

    // Substring machine_id
    machine = allMachines.find(m => m.machine_id.toLowerCase().includes(lower)) || null;
    return { machine, allMachines };
  }

  /**
   * Update engine priority for a machine.
   */
  async updateEnginePriority(machineId: string, enginePriority: string[]): Promise<MachineRecord> {
    const { data, error } = await this.supabase
      .from('machine_registry')
      .update({ engine_priority: enginePriority })
      .eq('machine_id', machineId)
      .select()
      .single();

    if (error) throw new Error(error.message || JSON.stringify(error));
    return data as MachineRecord;
  }

  /**
   * Unassign tasks from a machine (set assigned_machine to null for queued tasks).
   */
  async unassignTasksFromMachine(machineId: string): Promise<number> {
    const { data, error } = await this.supabase
      .from('itachi_tasks')
      .update({ assigned_machine: null })
      .eq('assigned_machine', machineId)
      .eq('status', 'queued')
      .select('id');

    if (error) return 0;
    return data?.length || 0;
  }
}
