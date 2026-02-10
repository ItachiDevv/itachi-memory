import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Task, Config, TaskClassification, Engine } from './types';

const PROMPT_DIR = path.join(os.tmpdir(), 'itachi-prompts');
fs.mkdirSync(PROMPT_DIR, { recursive: true });

const DIFFICULTY_MAP: Record<TaskClassification['difficulty'], {
    model: TaskClassification['suggestedModel'];
    budget: number;
    useTeams: boolean;
    teamSize: number;
}> = {
    trivial: { model: 'opus', budget: 0.50, useTeams: false, teamSize: 1 },
    simple: { model: 'opus', budget: 2.00, useTeams: false, teamSize: 1 },
    medium: { model: 'opus', budget: 5.00, useTeams: false, teamSize: 1 },
    complex: { model: 'opus', budget: 10.00, useTeams: false, teamSize: 1 },
    major: { model: 'opus', budget: 25.00, useTeams: true, teamSize: 3 },
};

/**
 * Pick engine based on: task.engine override > classifier hint > config default.
 * Codex is preferred for tasks the classifier flags, but only if OPENAI_API_KEY is available.
 */
function resolveEngine(hint: Engine | undefined, task: Task, config: Config): Engine {
    // Explicit task-level override (e.g. /task --engine codex ...)
    if ((task as any).engine === 'codex' || (task as any).engine === 'claude') {
        return (task as any).engine;
    }
    // Classifier hint
    if (hint && hint === 'codex') return 'codex';
    // Config default
    if (config.defaultEngine === 'codex') return 'codex';
    return 'claude';
}

const CLASSIFICATION_PROMPT = `You are a task difficulty classifier for a software engineering AI agent system.

Given a task description and project name, classify the task difficulty and estimate the resources needed.

Respond with ONLY a JSON object (no markdown, no explanation) with these fields:
- difficulty: one of "trivial", "simple", "medium", "complex", "major"
- reasoning: brief explanation (1-2 sentences)
- estimatedFiles: estimated number of files that need to be modified

Classification guide:
- trivial: Simple config changes, typo fixes, single-line edits (1-2 files)
- simple: Small bug fixes, adding a field, minor refactors (2-5 files)
- medium: New features, moderate refactors, multi-file changes (3-10 files)
- complex: Large features, architectural changes, cross-cutting concerns (5-20 files)
- major: Multi-system changes, major refactors, new subsystems (10+ files, needs agent teams)

Also include an "engine" field: "claude" or "codex".
- Use "claude" for most tasks (default, better at multi-file coordination, agent teams)
- Use "codex" for tasks that are heavily OpenAI-ecosystem (Python ML, data science, OpenAI API integrations) or when the task explicitly requests it`;

const DEFAULT_CLASSIFICATION: TaskClassification = {
    difficulty: 'medium',
    reasoning: 'Classification unavailable, defaulting to medium',
    suggestedModel: 'opus',
    engine: 'claude',
    useAgentTeams: false,
    teamSize: 1,
    estimatedFiles: 5,
};

export async function classifyTask(task: Task, config: Config): Promise<TaskClassification> {
    try {
        const prompt = `${CLASSIFICATION_PROMPT}\n\nProject: ${task.project}\nTask: ${task.description}`;

        // Write prompt to temp file to avoid shell quoting issues on Windows
        const promptFile = path.join(PROMPT_DIR, `classify-${task.id.substring(0, 8)}.txt`);
        fs.writeFileSync(promptFile, prompt, 'utf8');

        const readCmd = process.platform === 'win32'
            ? `type "${promptFile.replace(/\//g, '\\')}"`
            : `cat "${promptFile}"`;

        // Use Claude CLI with subscription auth (no API key needed)
        // Pipe prompt from file to avoid cmd.exe mangling args with quotes/newlines
        const output = execSync(
            `${readCmd} | claude --model haiku --max-turns 1 --output-format text --dangerously-skip-permissions`,
            { encoding: 'utf8', timeout: 30000 }
        ).trim();

        // Strip markdown code fences if the model wrapped JSON in ```json ... ```
        const text = output
            .replace(/^```(?:json)?\s*\n?/gm, '')
            .replace(/\n?```\s*$/gm, '')
            .trim();
        const parsed = JSON.parse(text);

        const difficulty = parsed.difficulty as TaskClassification['difficulty'];
        if (!DIFFICULTY_MAP[difficulty]) {
            console.warn(`[classifier] Unknown difficulty "${difficulty}", falling back to medium`);
            return DEFAULT_CLASSIFICATION;
        }

        const mapping = DIFFICULTY_MAP[difficulty];

        const engine = resolveEngine(parsed.engine, task, config);

        const classification: TaskClassification = {
            difficulty,
            reasoning: parsed.reasoning || 'No reasoning provided',
            suggestedModel: mapping.model,
            engine,
            useAgentTeams: engine === 'claude' ? mapping.useTeams : false, // Codex doesn't support agent teams
            teamSize: engine === 'claude' ? mapping.teamSize : 1,
            estimatedFiles: parsed.estimatedFiles || mapping.teamSize,
        };

        console.log(`[classifier] Task ${task.id.substring(0, 8)}: ${difficulty} → ${engine}/${mapping.model} ($${mapping.budget})`);
        return classification;
    } catch (err) {
        console.error('[classifier] Classification failed, using default:', err instanceof Error ? err.message : err);
        return DEFAULT_CLASSIFICATION;
    }
}

export function getBudgetForClassification(classification: TaskClassification): number {
    return DIFFICULTY_MAP[classification.difficulty]?.budget ?? 5.00;
}
