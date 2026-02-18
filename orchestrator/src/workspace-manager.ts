import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { decrypt, encrypt } from './crypto';
import * as os from 'os';
import { NoRepoError, type Task } from './types';

/** Machine-specific env keys that should be stripped before syncing */
const MACHINE_SPECIFIC_KEYS = ['ITACHI_ORCHESTRATOR_ID', 'ITACHI_WORKSPACE_DIR', 'ITACHI_PROJECT_PATHS'];

/** Env files to sync between machines via Supabase */
const SYNC_ENV_FILES = ['.env', '.env.local'];

/**
 * Fetch repo_url with multi-step discovery:
 * 1. Try API lookup (existing registration)
 * 2. If not found → trigger /api/repos/sync → retry API lookup
 * 3. If still not found → direct GitHub API lookup using GITHUB_TOKEN
 * 4. If found on GitHub → auto-register via /api/repos/register
 */
async function fetchRepoUrl(project: string): Promise<string | null> {
    const headers: Record<string, string> = {};
    if (process.env.ITACHI_API_KEY) headers['Authorization'] = `Bearer ${process.env.ITACHI_API_KEY}`;

    // Step 1: Try API lookup
    try {
        const res = await fetch(`${config.apiUrl}/api/repos/${encodeURIComponent(project)}`, { headers });
        if (res.ok) {
            const data = await res.json() as { repo_url?: string };
            if (data.repo_url) return data.repo_url;
        }
    } catch { /* continue to next step */ }

    // Step 2: Trigger repo sync and retry
    try {
        console.log(`[workspace] Repo "${project}" not found, triggering sync...`);
        await fetch(`${config.apiUrl}/api/repos/sync`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
        });
        // Retry lookup after sync
        const res = await fetch(`${config.apiUrl}/api/repos/${encodeURIComponent(project)}`, { headers });
        if (res.ok) {
            const data = await res.json() as { repo_url?: string };
            if (data.repo_url) return data.repo_url;
        }
    } catch { /* continue to next step */ }

    // Step 3: Direct GitHub API lookup
    const githubToken = process.env.GITHUB_TOKEN;
    const githubOwner = config.githubOwner;
    if (!githubToken || !githubOwner) return null;

    try {
        console.log(`[workspace] Trying GitHub API for "${githubOwner}/${project}"...`);
        const ghRes = await fetch(`https://api.github.com/repos/${githubOwner}/${project}`, {
            headers: {
                'Authorization': `token ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'itachi-orchestrator',
            },
        });
        if (!ghRes.ok) return null;

        const ghData = await ghRes.json() as { clone_url?: string; html_url?: string; name?: string };
        const repoUrl = ghData.clone_url;
        if (!repoUrl) return null;

        // Step 4: Auto-register the discovered repo
        console.log(`[workspace] Found "${project}" on GitHub, auto-registering...`);
        try {
            await fetch(`${config.apiUrl}/api/repos/register`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: ghData.name || project, repo_url: repoUrl }),
            });
        } catch {
            // Registration failed but we still have the URL
        }

        return repoUrl;
    } catch {
        return null;
    }
}

function exec(cmd: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
        // Strip GITHUB_TOKEN so gh CLI uses keyring auth from `gh auth login`
        const cleanEnv = { ...process.env };
        delete (cleanEnv as Record<string, string | undefined>).GITHUB_TOKEN;
        const proc = spawn(cmd, args, { cwd, shell: true, env: cleanEnv });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
            resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 });
        });
    });
}

/** Detect the actual default branch of a repo (master vs main) */
async function detectDefaultBranch(repoPath: string, isLocal: boolean): Promise<string | null> {
    // Try common branch names in order of preference
    const candidates = isLocal
        ? ['master', 'main', 'develop']
        : ['origin/master', 'origin/main', 'origin/develop'];

    for (const ref of candidates) {
        const check = await exec('git', ['rev-parse', '--verify', ref], repoPath);
        if (check.code === 0) return ref;
    }

    // Last resort: get current HEAD branch
    const head = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
    if (head.code === 0 && head.stdout && head.stdout !== 'HEAD') {
        return isLocal ? head.stdout : `origin/${head.stdout}`;
    }

    return null;
}

/** Get the base repo path for a project (persistent clone or configured local path) */
function getBasePath(task: Task): { basePath: string; isLocal: boolean } {
    const localPath = config.projectPaths[task.project];
    if (localPath && fs.existsSync(localPath)) {
        return { basePath: localPath, isLocal: true };
    }
    // Persistent base clone directory
    const basesDir = path.join(config.workspaceDir, 'bases');
    return { basePath: path.join(basesDir, task.project), isLocal: false };
}

/**
 * Ensure a base clone exists for the project. If it already exists, fetch latest.
 * Returns the base clone path.
 */
async function ensureBaseClone(task: Task): Promise<string> {
    const repoUrl = task.repo_url || await fetchRepoUrl(task.project);
    if (!repoUrl) {
        throw new NoRepoError(task.project);
    }

    const { basePath } = getBasePath(task);
    const basesDir = path.dirname(basePath);
    fs.mkdirSync(basesDir, { recursive: true });

    if (fs.existsSync(path.join(basePath, '.git'))) {
        // Base clone exists — fetch latest
        console.log(`[workspace] Fetching latest for base clone ${task.project}`);
        await exec('git', ['fetch', '--all'], basePath);
    } else {
        // First time — full clone (try specified branch, fall back to repo default)
        console.log(`[workspace] Creating base clone for ${task.project}`);
        let result = await exec(
            'git',
            ['clone', '--branch', task.branch, repoUrl, basePath]
        );
        if (result.code !== 0 && result.stderr.includes('not found')) {
            // Branch doesn't exist — clone without --branch (uses repo default)
            console.log(`[workspace] Branch "${task.branch}" not found, cloning with repo default`);
            result = await exec('git', ['clone', repoUrl, basePath]);
        }
        if (result.code !== 0) {
            throw new Error(`Failed to clone: ${result.stderr}`);
        }
    }

    // Ensure .gitignore in base excludes .env files
    ensureGitignoreExcludes(path.join(basePath, '.gitignore'), ['.env', '.env.*', '.env.local']);

    return basePath;
}

/** Generate a short slug from a task description for use in branch/worktree names */
export function slugifyDescription(description: string): string {
    // Common filler words to skip
    const stopWords = new Set(['the', 'a', 'an', 'to', 'for', 'in', 'on', 'of', 'and', 'is', 'it', 'that', 'this', 'with']);
    const words = description
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 0 && !stopWords.has(w));
    const slug = words.slice(0, 3).join('-');
    return slug ? slug.substring(0, 30) : 'task';
}

export async function setupWorkspace(task: Task): Promise<string> {
    fs.mkdirSync(config.workspaceDir, { recursive: true });

    const slug = slugifyDescription(task.description);
    const shortId = task.id.substring(0, 8);
    const workspaceName = `${task.project}-${slug}`;
    const workspacePath = path.join(config.workspaceDir, workspaceName);
    const branchName = `task/${slug}`;

    const { basePath, isLocal } = getBasePath(task);

    if (isLocal) {
        // Local path mode — fetch latest, create worktree
        await exec('git', ['fetch', '--all'], basePath);
    } else {
        // Clone mode — ensure persistent base clone exists and is up to date
        await ensureBaseClone(task);
    }

    // Resolve the base ref — try the specified branch, then detect the actual default
    let baseRef = isLocal ? task.branch : `origin/${task.branch}`;
    const refCheck = await exec('git', ['rev-parse', '--verify', baseRef], basePath);
    if (refCheck.code !== 0) {
        // Specified branch doesn't exist — detect actual default branch
        const detected = await detectDefaultBranch(basePath, isLocal);
        if (detected) {
            console.log(`[workspace] Branch "${task.branch}" not found, using detected default: ${detected}`);
            baseRef = detected;
        }
    }

    // Create worktree from base
    const result = await exec(
        'git',
        ['worktree', 'add', workspacePath, '-b', branchName, baseRef],
        basePath
    );

    if (result.code !== 0) {
        // Branch already exists — try without -b
        const retry = await exec(
            'git',
            ['worktree', 'add', workspacePath, branchName],
            basePath
        );
        if (retry.code !== 0) {
            throw new Error(`Failed to create worktree: ${retry.stderr}`);
        }
    }

    console.log(`[workspace] Created worktree at ${workspacePath} (branch: ${branchName}, base: ${isLocal ? 'local' : 'clone'})`);

    // Pull latest .env files from Supabase (source of truth for cross-machine sync)
    await pullProjectEnv(workspacePath, task);

    return workspacePath;
}

/**
 * Pull .env files from Supabase (encrypted) into the worktree.
 * Always runs — this is the source of truth for cross-machine env sync.
 */
async function pullProjectEnv(workspacePath: string, task: Task): Promise<void> {
    if (!config.syncPassphrase) return;

    const headers: Record<string, string> = {};
    if (process.env.ITACHI_API_KEY) headers['Authorization'] = `Bearer ${process.env.ITACHI_API_KEY}`;

    for (const envFile of SYNC_ENV_FILES) {
        try {
            const res = await fetch(
                `${config.apiUrl}/api/sync/pull/${encodeURIComponent(task.project)}/${encodeURIComponent(envFile)}`,
                { headers }
            );

            if (!res.ok) continue; // No synced file for this name, skip silently

            const data = await res.json() as { encrypted_data?: string; salt?: string };
            if (!data.encrypted_data || !data.salt) continue;

            const envContent = decrypt(data.encrypted_data, data.salt, config.syncPassphrase);
            const localPath = path.join(workspacePath, envFile);

            if (fs.existsSync(localPath)) {
                // Merge: remote wins for shared keys, local-only keys preserved, machine keys untouched
                const localContent = fs.readFileSync(localPath, 'utf8');
                const merged = mergeEnv(localContent, envContent);
                fs.writeFileSync(localPath, merged, 'utf8');
                console.log(`[workspace] Merged synced ${envFile} for ${task.project}`);
            } else {
                fs.writeFileSync(localPath, envContent, 'utf8');
                console.log(`[workspace] Wrote synced ${envFile} for ${task.project}`);
            }
        } catch {
            // Non-fatal — continue without this env file
        }
    }
}

/**
 * Merge local and remote .env content.
 * Remote wins for shared keys. Local-only keys preserved. Machine-specific keys kept from local.
 */
function mergeEnv(local: string, remote: string): string {
    const localKV: Record<string, string> = {};
    const remoteKV: Record<string, string> = {};
    const kvRe = /^([A-Za-z_]\w*)=(.*)$/;

    for (const line of local.split('\n')) {
        const m = line.match(kvRe);
        if (m) localKV[m[1]] = m[2];
    }
    for (const line of remote.split('\n')) {
        const m = line.match(kvRe);
        if (m) remoteKV[m[1]] = m[2];
    }

    // Remote wins for shared keys
    Object.assign(localKV, remoteKV);

    // Machine-specific keys always kept from local original
    for (const line of local.split('\n')) {
        const m = line.match(kvRe);
        if (m && MACHINE_SPECIFIC_KEYS.includes(m[1])) {
            localKV[m[1]] = m[2];
        }
    }

    return Object.entries(localKV).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

export async function getFilesChanged(workspacePath: string): Promise<string[]> {
    const files = new Set<string>();

    // 1. Find the base branch to compare against
    const defaultBranch = await detectDefaultBranch(workspacePath, false);
    const baseRef = defaultBranch || 'origin/main';

    // 2. Find merge-base (where task branch forked from base)
    const mergeBase = await exec('git', ['merge-base', 'HEAD', baseRef], workspacePath);
    if (mergeBase.code === 0 && mergeBase.stdout) {
        // Get all files changed in commits since the fork point
        const committed = await exec('git', ['diff', '--name-only', mergeBase.stdout, 'HEAD'], workspacePath);
        if (committed.code === 0) {
            committed.stdout.split('\n').filter(Boolean).forEach(f => files.add(f));
        }
    }

    // 3. Uncommitted changes in working directory
    const uncommitted = await exec('git', ['diff', '--name-only'], workspacePath);
    if (uncommitted.code === 0) {
        uncommitted.stdout.split('\n').filter(Boolean).forEach(f => files.add(f));
    }

    // 4. Staged changes
    const staged = await exec('git', ['diff', '--name-only', '--cached'], workspacePath);
    if (staged.code === 0) {
        staged.stdout.split('\n').filter(Boolean).forEach(f => files.add(f));
    }

    return [...files];
}

export async function commitAndPush(workspacePath: string, task: Task): Promise<string | null> {
    const slug = slugifyDescription(task.description);
    const shortId = task.id.substring(0, 8);

    // Check if there are uncommitted changes
    const status = await exec('git', ['status', '--porcelain'], workspacePath);
    const hasUncommitted = !!status.stdout.trim();

    if (hasUncommitted) {
        // Ensure .env files are never committed to git
        ensureGitignoreExcludes(path.join(workspacePath, '.gitignore'), ['.env', '.env.*', '.env.local']);

        // Stage all changes (safe now — .env* excluded via .gitignore)
        await exec('git', ['add', '-A'], workspacePath);

        // Double-check: unstage any .env files that slipped through
        await exec('git', ['reset', 'HEAD', '--', '.env', '.env.*', '.env.local'], workspacePath);

        // Check if there's still anything staged after excluding .env
        const staged = await exec('git', ['diff', '--cached', '--name-only'], workspacePath);
        if (!staged.stdout.trim()) {
            console.log(`[workspace] No non-env changes to commit for task ${shortId}`);
        } else {
            const commitMsg = `${slug}: ${task.description.substring(0, 72)}`;
            await exec('git', ['commit', '-m', commitMsg], workspacePath);
        }
    }

    // Check if the task branch has any commits to push (handles both cases:
    // 1. We just committed above, or 2. Claude already committed during the session)
    const log = await exec('git', ['log', '--oneline', '@{u}..HEAD'], workspacePath);
    const hasCommits = log.code === 0 && !!log.stdout.trim();
    // If no upstream yet, check if we have any commits beyond the merge base
    const hasNewCommits = hasCommits || log.code !== 0;

    if (!hasUncommitted && !hasNewCommits) {
        console.log(`[workspace] No changes to commit for task ${shortId}`);
        return null;
    }

    // Push
    const pushResult = await exec('git', ['push', '-u', 'origin', 'HEAD'], workspacePath);
    if (pushResult.code !== 0) {
        console.error(`[workspace] Push failed: ${pushResult.stderr}`);
        return null;
    }

    const lastCommit = await exec('git', ['log', '-1', '--pretty=%s'], workspacePath);
    return lastCommit.stdout || `task/${slug}`;
}

/** Ensure .gitignore contains the given patterns. Appends missing ones. */
function ensureGitignoreExcludes(gitignorePath: string, patterns: string[]): void {
    let content = '';
    if (fs.existsSync(gitignorePath)) {
        content = fs.readFileSync(gitignorePath, 'utf8');
    }
    const lines = new Set(content.split('\n').map(l => l.trim()));
    const missing = patterns.filter(p => !lines.has(p));
    if (missing.length > 0) {
        const suffix = content.endsWith('\n') || content === '' ? '' : '\n';
        fs.writeFileSync(gitignorePath, content + suffix + missing.join('\n') + '\n', 'utf8');
    }
}

export async function createPR(workspacePath: string, task: Task): Promise<string | null> {
    const slug = slugifyDescription(task.description);

    // Detect actual default branch (task.branch may say "main" when repo uses "master")
    let baseBranch = task.branch;
    const detected = await detectDefaultBranch(workspacePath, false);
    if (detected) {
        baseBranch = detected.replace(/^origin\//, '');
    }

    // Use shell-safe quoting for args with spaces
    const title = `${slug}: ${task.description.substring(0, 72)}`.replace(/"/g, '\\"');
    const body = `Automated task via Itachi orchestrator.\n\nTask ID: ${task.id}\nProject: ${task.project}`.replace(/"/g, '\\"');

    const result = await exec(
        'gh',
        [
            'pr', 'create',
            '--title', `"${title}"`,
            '--body', `"${body}"`,
            '--base', baseBranch,
        ],
        workspacePath
    );

    if (result.code !== 0) {
        console.error(`[workspace] PR creation failed: ${result.stderr}`);
        return null;
    }

    // Extract PR URL from output
    const urlMatch = result.stdout.match(/https:\/\/github\.com\/.+\/pull\/\d+/);
    return urlMatch ? urlMatch[0] : result.stdout.trim();
}

/**
 * Push .env files from worktree to Supabase (encrypted) so other orchestrators can pull them.
 * Strips machine-specific keys before encrypting.
 * Called after task completion, before workspace cleanup.
 */
export async function pushProjectEnv(workspacePath: string, task: Task): Promise<void> {
    if (!config.syncPassphrase) return;

    for (const envFile of SYNC_ENV_FILES) {
        const envPath = path.join(workspacePath, envFile);
        if (!fs.existsSync(envPath)) continue;

        try {
            let content = fs.readFileSync(envPath, 'utf8');

            // Strip machine-specific keys before syncing
            const re = new RegExp(`^(${MACHINE_SPECIFIC_KEYS.join('|')})=.*$`, 'gm');
            content = content.replace(re, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';

            // Encrypt
            const { encrypted_data, salt, content_hash } = encrypt(content, config.syncPassphrase);

            // Push to sync API
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (process.env.ITACHI_API_KEY) headers['Authorization'] = `Bearer ${process.env.ITACHI_API_KEY}`;

            const res = await fetch(`${config.apiUrl}/api/sync/push`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    repo_name: task.project,
                    file_path: envFile,
                    encrypted_data,
                    salt,
                    content_hash,
                    updated_by: `orchestrator:${os.hostname()}`,
                }),
            });

            if (res.ok) {
                const data = await res.json() as { version?: number };
                console.log(`[workspace] Pushed ${envFile} for ${task.project} (v${data.version || '?'})`);
            } else {
                console.log(`[workspace] Failed to push ${envFile} for ${task.project}: ${res.status}`);
            }
        } catch (err) {
            console.log(`[workspace] Error pushing ${envFile} for ${task.project}:`, err instanceof Error ? err.message : String(err));
        }
    }
}

/**
 * Cleanup: remove the task worktree only. Base clone persists for future tasks.
 */
export async function cleanupWorkspace(workspacePath: string, task: Task): Promise<void> {
    const { basePath } = getBasePath(task);

    // Remove worktree (works for both local-path and clone modes)
    const result = await exec('git', ['worktree', 'remove', workspacePath, '--force'], basePath);
    if (result.code !== 0) {
        // Fallback: if worktree remove fails, delete directory manually
        console.warn(`[workspace] worktree remove failed, falling back to rm: ${result.stderr}`);
        fs.rmSync(workspacePath, { recursive: true, force: true });
    }

    // Prune stale worktree entries
    await exec('git', ['worktree', 'prune'], basePath);

    console.log(`[workspace] Removed worktree at ${workspacePath} (base preserved: ${basePath})`);
}
