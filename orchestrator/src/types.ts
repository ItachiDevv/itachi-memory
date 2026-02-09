export interface Task {
    id: string;
    description: string;
    project: string;
    repo_url: string | null;
    branch: string;
    target_branch: string | null;
    status: 'queued' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
    priority: number;
    model: string;
    max_budget_usd: number;
    session_id: string | null;
    result_summary: string | null;
    result_json: Record<string, unknown> | null;
    error_message: string | null;
    files_changed: string[];
    pr_url: string | null;
    telegram_chat_id: number;
    telegram_user_id: number;
    orchestrator_id: string | null;
    workspace_path: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
}

export interface TaskUpdate {
    status?: Task['status'];
    target_branch?: string;
    session_id?: string;
    result_summary?: string;
    result_json?: Record<string, unknown>;
    error_message?: string;
    files_changed?: string[];
    pr_url?: string;
    workspace_path?: string;
    started_at?: string;
    completed_at?: string;
}

export interface ClaudeStreamEvent {
    type: string;
    subtype?: string;
    session_id?: string;
    message?: {
        role: string;
        content: string;
    };
    tool_use?: {
        name: string;
        input: Record<string, unknown>;
    };
    result?: {
        text: string;
        session_id: string;
        cost_usd: number;
        duration_ms: number;
        is_error: boolean;
    };
}

export interface ElizaStreamEvent {
    type: 'text' | 'tool_use' | 'result';
    text?: string;
    tool_use?: {
        name: string;
        input: Record<string, unknown>;
    };
    result?: {
        summary: string;
        cost_usd: number;
        duration_ms: number;
        is_error: boolean;
        files_changed?: string[];
        pr_url?: string | null;
    };
}

export type Engine = 'claude' | 'codex';

export interface TaskClassification {
    difficulty: 'trivial' | 'simple' | 'medium' | 'complex' | 'major';
    reasoning: string;
    suggestedModel: 'haiku' | 'sonnet' | 'opus';
    engine: Engine;
    useAgentTeams: boolean;
    teamSize: number;
    estimatedFiles: number;
}

export interface CodexStreamEvent {
    type: string;
    thread_id?: string;
    item?: {
        id: string;
        type: string;
        command?: string;
        content?: string;
        exit_code?: number;
    };
    usage?: {
        input_tokens: number;
        output_tokens: number;
    };
}

export interface ActiveSession {
    task: Task;
    workspacePath: string;
    startedAt: Date;
    timeoutHandle: NodeJS.Timeout;
    classification?: TaskClassification;
}

export interface Config {
    supabaseUrl: string;
    supabaseKey: string;
    orchestratorId: string;
    maxConcurrent: number;
    workspaceDir: string;
    taskTimeoutMs: number;
    defaultModel: string;
    defaultBudget: number;
    defaultEngine: Engine;
    pollIntervalMs: number;
    projectPaths: Record<string, string>;
    projectFilter?: string;
    apiUrl: string;
    syncPassphrase: string;
    machineId: string;
    machineDisplayName: string;
}
