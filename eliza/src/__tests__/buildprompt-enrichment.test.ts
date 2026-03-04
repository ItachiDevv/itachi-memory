import { describe, it, expect } from 'bun:test';

// ============================================================
// Tests for buildPrompt enrichment logic (mirrored from task-executor-service.ts)
// Verifies memory inclusion, project rules, error handling,
// and operational vs code-change task detection.
// ============================================================

interface MockMemory {
  id: string;
  summary: string;
  content: string;
  category: string;
}

interface MockTask {
  description: string;
  project: string;
}

/** Mirror of operational detection from task-executor-service.ts */
function isOperationalTask(description: string): boolean {
  const descLower = description.toLowerCase();
  return /\b(env\s*var|environment\s*var|logs?|disk\s*space|status|uptime|container|docker|restart|stop|start|memory\s*usage|cpu|df\b|top\b|htop|ps\b|free\b|du\b|systemctl|journalctl)\b/.test(descLower)
    && !/\b(fix|implement|refactor|create|add|build|write|rewrite|scaffold|migrate)\b/.test(descLower);
}

/** Simplified mirror of buildPrompt from task-executor-service.ts */
async function buildPrompt(
  task: MockTask,
  memories: MockMemory[] | null,
  rules: MockMemory[] | null,
  memoryError: boolean = false,
): Promise<string> {
  if (!task.description?.trim()) {
    throw new Error('Task has empty description — cannot build prompt');
  }

  const isOperational = isOperationalTask(task.description);

  const lines: string[] = [
    `You are working on project "${task.project}".`,
    '',
    task.description,
    '',
  ];

  if (isOperational) {
    lines.push(
      'Instructions:',
      '- This is an operational/info-gathering task, NOT a code change.',
    );
  } else {
    lines.push(
      'Instructions:',
      '- Work autonomously. Make all necessary changes.',
    );
  }

  if (memoryError) {
    // Simulate error path — prompt still works without memories
    return lines.join('\n');
  }

  if (memories && memories.length > 0) {
    lines.push('', '--- Relevant context from memory ---');
    for (const mem of memories) {
      lines.push(`- ${mem.summary || mem.content?.substring(0, 200)}`);
    }
  }

  if (rules && rules.length > 0) {
    lines.push('', '--- Project rules ---');
    for (const rule of rules) {
      lines.push(`- ${rule.summary || rule.content?.substring(0, 200)}`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// 1. Memory inclusion
// ============================================================

describe('buildPrompt — memory inclusion', () => {
  it('should include relevant memories in prompt', async () => {
    const prompt = await buildPrompt(
      { description: 'Fix login button', project: 'my-app' },
      [
        { id: '1', summary: 'Login requires CSRF token', content: '', category: 'task_lesson' },
        { id: '2', summary: 'Button component in src/ui/', content: '', category: 'code_change' },
      ],
      null,
    );

    expect(prompt).toContain('Relevant context from memory');
    expect(prompt).toContain('Login requires CSRF token');
    expect(prompt).toContain('Button component in src/ui/');
  });

  it('should include project rules section', async () => {
    const prompt = await buildPrompt(
      { description: 'Add dark mode', project: 'my-app' },
      null,
      [
        { id: 'r1', summary: 'Always run tests before push', content: '', category: 'project_rule' },
      ],
    );

    expect(prompt).toContain('Project rules');
    expect(prompt).toContain('Always run tests before push');
  });

  it('should handle empty memories gracefully', async () => {
    const prompt = await buildPrompt(
      { description: 'Fix the bug', project: 'my-app' },
      [],
      [],
    );

    expect(prompt).not.toContain('Relevant context from memory');
    expect(prompt).not.toContain('Project rules');
    expect(prompt).toContain('Fix the bug');
  });

  it('should handle memory service errors gracefully', async () => {
    const prompt = await buildPrompt(
      { description: 'Fix the bug', project: 'my-app' },
      null,
      null,
      true, // simulate error
    );

    expect(prompt).toContain('Fix the bug');
    expect(prompt).not.toContain('Relevant context from memory');
  });
});

// ============================================================
// 2. Operational vs code-change detection
// ============================================================

describe('buildPrompt — operational detection', () => {
  it('should detect operational tasks (check logs)', () => {
    expect(isOperationalTask('Check container logs for errors')).toBe(true);
  });

  it('should detect operational tasks (disk space)', () => {
    expect(isOperationalTask('Check disk space on the server')).toBe(true);
  });

  it('should detect code-change tasks', () => {
    expect(isOperationalTask('Fix the login button styling')).toBe(false);
  });

  it('should detect hybrid as code-change (fix + docker)', () => {
    // "fix" keyword overrides operational detection
    expect(isOperationalTask('Fix the Docker container restart loop')).toBe(false);
  });

  it('should produce operational instructions for info tasks', async () => {
    const prompt = await buildPrompt(
      { description: 'Check container uptime', project: 'my-app' },
      null,
      null,
    );

    expect(prompt).toContain('operational/info-gathering task');
  });

  it('should produce code-change instructions for dev tasks', async () => {
    const prompt = await buildPrompt(
      { description: 'Implement dark mode toggle', project: 'my-app' },
      null,
      null,
    );

    expect(prompt).toContain('Work autonomously');
  });
});
