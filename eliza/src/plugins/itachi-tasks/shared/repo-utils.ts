import type { IAgentRuntime } from '@elizaos/core';
import type { SSHService } from '../services/ssh-service.js';
import type { TaskService } from '../services/task-service.js';
import type { TelegramTopicsService } from '../services/telegram-topics.js';
import { getStartingDir } from './start-dir.js';

/**
 * Map machine_id (registry) or common aliases → SSH target name.
 * Used by task-executor-service, callback-handler, and interactive flows.
 */
export const MACHINE_TO_SSH_TARGET: Record<string, string> = {
  // Direct SSH target names
  mac: 'mac',
  windows: 'windows',
  hetzner: 'coolify',
  coolify: 'coolify',
  // Machine registry IDs (from orchestrator registration)
  'itachi-m1': 'mac',
  'windows-pc': 'windows',
  // Common aliases
  macbook: 'mac',
  desktop: 'windows',
  server: 'coolify',
  vps: 'coolify',
};

/** Resolve a machine identifier to an SSH target name */
export function resolveSSHTarget(machineId: string): string {
  return MACHINE_TO_SSH_TARGET[machineId] || MACHINE_TO_SSH_TARGET[machineId.toLowerCase()] || machineId;
}

/**
 * Get all machine IDs (registry + aliases) that map to a given SSH target.
 * Used by executor to claim tasks assigned to any alias of its managed machines.
 */
export function getMachineIdsForTarget(sshTarget: string): string[] {
  const ids = new Set<string>();
  ids.add(sshTarget);
  for (const [key, value] of Object.entries(MACHINE_TO_SSH_TARGET)) {
    if (value === sshTarget) ids.add(key);
  }
  return [...ids];
}

/** Default repo paths per SSH target */
export const DEFAULT_REPO_PATHS: Record<string, string> = {
  mac: '~/itachi/itachi-memory',
  windows: '~/Documents/Crypto/skills-plugins/itachi-memory',
  coolify: '/app',
};

/** Base directories where repos are typically cloned per machine */
export const DEFAULT_REPO_BASES: Record<string, string> = {
  mac: '~/itachi',
  windows: '~/Documents/Crypto',
  coolify: '/tmp/repos',
};

export interface RepoResolution {
  repoPath: string;
  project: string;
  fallbackUsed: boolean;
}

/**
 * Resolve the best repo path on the target machine for the given prompt/project.
 * Matches project names from the registry against the prompt text,
 * checks if the repo exists on the target via SSH, and clones if needed.
 */
export async function resolveRepoPath(
  target: string,
  prompt: string,
  sshService: SSHService,
  taskService: TaskService,
  topicId: number | null,
  topicsService: TelegramTopicsService | null,
  logger: IAgentRuntime['logger'],
): Promise<RepoResolution> {
  const fallback = DEFAULT_REPO_PATHS[target] || '~';
  const fallbackProject = fallback.split('/').pop() || 'unknown';

  let repos;
  try {
    repos = await taskService.getMergedRepos();
  } catch (err) {
    logger.warn(`[repo-utils] Failed to fetch repos: ${err instanceof Error ? err.message : String(err)}`);
    return { repoPath: fallback, project: fallbackProject, fallbackUsed: true };
  }

  if (repos.length === 0) {
    return { repoPath: fallback, project: fallbackProject, fallbackUsed: true };
  }

  // Match project name in prompt (case-insensitive word boundary)
  const promptLower = prompt.toLowerCase();
  const matched = repos.find((r) => {
    const pattern = new RegExp(`\\b${r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return pattern.test(promptLower);
  });

  if (!matched) {
    return { repoPath: fallback, project: fallbackProject, fallbackUsed: true };
  }

  const base = getStartingDir(target);
  const candidatePath = `${base}/${matched.name}`;

  // Check if repo exists on target (case-insensitive directory lookup)
  try {
    const isWindows = sshService.isWindowsTarget(target);
    const escapedName = matched.name.replace(/'/g, "''");
    const findCmd = isWindows
      ? `if (Test-Path '${base}/${escapedName}') { Write-Output '${base}/${escapedName}' } else { Write-Output 'MISSING' }`
      : `found=$(find ${base} -maxdepth 1 -iname '${matched.name.replace(/'/g, "'\\''")}' -type d 2>/dev/null | head -1) && [ -n "$found" ] && echo "$found" || echo MISSING`;
    const check = await sshService.exec(target, findCmd, 5_000);
    const output = (check.stdout || '').trim();

    if (output !== 'MISSING' && output !== '') {
      logger.info(`[repo-utils] Repo ${matched.name} found at ${output} on ${target}`);
      return { repoPath: output, project: matched.name, fallbackUsed: false };
    }

    // Repo missing — try to clone if we have a URL
    if (matched.repo_url) {
      if (topicId && topicsService) {
        await topicsService.sendToTopic(topicId, `Cloning ${matched.name} on ${target}...`);
      }
      logger.info(`[repo-utils] Cloning ${matched.repo_url} → ${candidatePath} on ${target}`);

      const clone = await sshService.exec(
        target,
        `git clone ${matched.repo_url} ${candidatePath} 2>&1`,
        120_000,
      );

      if (clone.success) {
        if (topicId && topicsService) {
          await topicsService.sendToTopic(topicId, `Cloned ${matched.name} successfully.`);
        }
        return { repoPath: candidatePath, project: matched.name, fallbackUsed: false };
      }

      logger.warn(`[repo-utils] Clone failed: ${clone.stderr || clone.stdout}`);
      if (topicId && topicsService) {
        await topicsService.sendToTopic(topicId, `Clone failed, falling back to default repo path.`);
      }
    } else {
      logger.info(`[repo-utils] Repo ${matched.name} not found on ${target} and no clone URL available`);
    }
  } catch (err) {
    logger.warn(`[repo-utils] SSH check failed for ${candidatePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { repoPath: fallback, project: fallbackProject, fallbackUsed: true };
}

/**
 * Resolve repo path by exact project name (for task executor where project is already known).
 */
export async function resolveRepoPathByProject(
  target: string,
  project: string,
  repoUrl: string | undefined,
  sshService: SSHService,
  logger: IAgentRuntime['logger'],
): Promise<string | null> {
  const base = getStartingDir(target);

  try {
    const isWindows = sshService.isWindowsTarget(target);
    const escapedProject = project.replace(/'/g, "''");
    const findCmd = isWindows
      ? `if (Test-Path '${base}/${escapedProject}') { Write-Output '${base}/${escapedProject}' } else { Write-Output 'MISSING' }`
      : `found=$(find ${base} -maxdepth 1 -iname '${project.replace(/'/g, "'\\''")}' -type d 2>/dev/null | head -1) && [ -n "$found" ] && echo "$found" || echo MISSING`;
    const check = await sshService.exec(target, findCmd, 5_000);
    const output = (check.stdout || '').trim();

    if (output !== 'MISSING' && output !== '') {
      return output;
    }

    // Clone if URL available
    if (repoUrl) {
      const candidatePath = `${base}/${project}`;
      logger.info(`[repo-utils] Cloning ${repoUrl} → ${candidatePath} on ${target}`);
      const clone = await sshService.exec(target, `git clone ${repoUrl} ${candidatePath} 2>&1`, 120_000);
      if (clone.success) return candidatePath;
      logger.warn(`[repo-utils] Clone failed: ${clone.stderr || clone.stdout}`);
    }
  } catch (err) {
    logger.warn(`[repo-utils] resolveRepoPathByProject failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}
