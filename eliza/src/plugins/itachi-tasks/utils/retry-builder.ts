export const MAX_RETRIES = 2;

const UNRETRYABLE_PATTERNS = [
  'invalid credentials',
  'repo not found',
];

export interface RetryableTask {
  description?: string;
  error_message?: string;
  retry_count?: number;
  status?: string;
}

/**
 * Builds a retry prompt that includes what went wrong and instructs the agent
 * to try a different approach.
 */
export function buildRetryPrompt(originalTask: string, failureReason: string): string {
  return [
    'Previous attempt failed with the following error:',
    failureReason,
    '',
    'Original task:',
    originalTask,
    '',
    'Please try a different approach to complete this task.',
  ].join('\n');
}

/**
 * Returns true if the task should be automatically retried.
 * Retries are allowed when retry_count < MAX_RETRIES and the error is not
 * one of the known-unretryable patterns (e.g. invalid credentials, repo not found).
 */
export function shouldAutoRetry(task: RetryableTask): boolean {
  const retryCount = task.retry_count ?? 0;
  if (retryCount >= MAX_RETRIES) return false;

  const errorMsg = (task.error_message ?? '').toLowerCase();
  for (const pattern of UNRETRYABLE_PATTERNS) {
    if (errorMsg.includes(pattern)) return false;
  }

  return true;
}
