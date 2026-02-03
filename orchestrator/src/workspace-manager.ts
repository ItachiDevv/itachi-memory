import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import type { Task } from './types';

function exec(cmd: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
        const proc = spawn(cmd, args, { cwd, shell: true });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
            resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 });
        });
    });
}

export async function setupWorkspace(task: Task): Promise<string> {
    // Ensure base workspace dir exists
    fs.mkdirSync(config.workspaceDir, { recursive: true });

    const shortId = task.id.substring(0, 8);
    const workspaceName = `${task.project}-${shortId}`;
    const workspacePath = path.join(config.workspaceDir, workspaceName);

    // Check if project has a local path configured (worktree mode)
    const localPath = config.projectPaths[task.project];

    if (localPath && fs.existsSync(localPath)) {
        // Worktree mode: create a git worktree from the local repo
        const branchName = `task/${shortId}`;

        // Fetch latest
        await exec('git', ['fetch', '--all'], localPath);

        // Create worktree
        const result = await exec(
            'git',
            ['worktree', 'add', workspacePath, '-b', branchName, task.branch],
            localPath
        );

        if (result.code !== 0) {
            // Branch might already exist, try without -b
            const retry = await exec(
                'git',
                ['worktree', 'add', workspacePath, branchName],
                localPath
            );
            if (retry.code !== 0) {
                throw new Error(`Failed to create worktree: ${retry.stderr}`);
            }
        }

        console.log(`[workspace] Created worktree at ${workspacePath} (branch: ${branchName})`);
    } else if (task.repo_url) {
        // Clone mode: shallow clone from remote
        const result = await exec(
            'git',
            ['clone', '--depth', '1', '--branch', task.branch, task.repo_url, workspacePath]
        );

        if (result.code !== 0) {
            throw new Error(`Failed to clone: ${result.stderr}`);
        }

        // Create feature branch
        const branchName = `task/${shortId}`;
        await exec('git', ['checkout', '-b', branchName], workspacePath);

        console.log(`[workspace] Cloned ${task.repo_url} to ${workspacePath} (branch: ${branchName})`);
    } else {
        // No repo_url and no local path - just create the directory
        // This is for tasks that operate on the project path directly
        if (localPath) {
            return localPath;
        }
        throw new Error(`No repo_url or local path configured for project "${task.project}"`);
    }

    return workspacePath;
}

export async function getFilesChanged(workspacePath: string): Promise<string[]> {
    const result = await exec('git', ['diff', '--stat', '--name-only', 'HEAD~1'], workspacePath);
    if (result.code !== 0) {
        // Try diff against initial state
        const alt = await exec('git', ['diff', '--name-only', '--cached'], workspacePath);
        return alt.stdout.split('\n').filter(Boolean);
    }
    return result.stdout.split('\n').filter(Boolean);
}

export async function commitAndPush(workspacePath: string, task: Task): Promise<string | null> {
    // Check if there are changes
    const status = await exec('git', ['status', '--porcelain'], workspacePath);
    if (!status.stdout.trim()) {
        console.log(`[workspace] No changes to commit for task ${task.id.substring(0, 8)}`);
        return null;
    }

    // Stage all changes
    await exec('git', ['add', '-A'], workspacePath);

    // Commit
    const shortId = task.id.substring(0, 8);
    const commitMsg = `task/${shortId}: ${task.description.substring(0, 72)}`;
    await exec('git', ['commit', '-m', commitMsg], workspacePath);

    // Push
    const pushResult = await exec('git', ['push', '-u', 'origin', 'HEAD'], workspacePath);
    if (pushResult.code !== 0) {
        console.error(`[workspace] Push failed: ${pushResult.stderr}`);
        return null;
    }

    return commitMsg;
}

export async function createPR(workspacePath: string, task: Task): Promise<string | null> {
    const shortId = task.id.substring(0, 8);
    const result = await exec(
        'gh',
        [
            'pr', 'create',
            '--title', `task/${shortId}: ${task.description.substring(0, 72)}`,
            '--body', `Automated task via Itachi orchestrator.\n\nTask ID: ${task.id}\nProject: ${task.project}`,
            '--base', task.branch,
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

export async function cleanupWorkspace(workspacePath: string, task: Task): Promise<void> {
    const localPath = config.projectPaths[task.project];

    if (localPath && fs.existsSync(localPath)) {
        // Worktree mode: remove worktree
        await exec('git', ['worktree', 'remove', workspacePath, '--force'], localPath);
        console.log(`[workspace] Removed worktree at ${workspacePath}`);
    } else {
        // Clone mode: delete directory
        fs.rmSync(workspacePath, { recursive: true, force: true });
        console.log(`[workspace] Deleted clone at ${workspacePath}`);
    }
}
