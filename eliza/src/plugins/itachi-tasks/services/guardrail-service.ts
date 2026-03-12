import { Service, type IAgentRuntime, ModelType } from '@elizaos/core';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';

export class GuardrailService extends Service {
  static serviceType = 'guardrails';
  capabilityDescription = 'Extracts failure patterns into guardrails for future sessions';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<GuardrailService> {
    const service = new GuardrailService(runtime);
    runtime.logger.info('GuardrailService started');
    return service;
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('GuardrailService stopped');
  }

  async createFromFailure(
    taskId: string,
    project: string,
    description: string,
    transcript: string,
    errorMessage?: string,
  ): Promise<string | null> {
    const memoryService = this.runtime.getService<MemoryService>('itachi-memory');
    if (!memoryService) return null;

    try {
      const prompt = [
        'You extract failure patterns into actionable guardrails. Be specific and concise. Output valid JSON only.',
        '',
        'A coding task failed. Extract a concise guardrail rule that would prevent this failure in future similar tasks.',
        '',
        `Task: ${description.substring(0, 300)}`,
        `Error: ${(errorMessage || 'unknown').substring(0, 300)}`,
        '',
        'Transcript (last portion):',
        transcript.substring(Math.max(0, transcript.length - 2000)),
        '',
        'Respond with ONLY a JSON object:',
        '{"pattern": "when doing X...", "guardrail": "always check Y first", "severity": "high"|"medium"|"low"}',
        '',
        'If the failure is too generic or not extractable (e.g. timeout with no clear cause), respond: {"pattern": null}',
      ].join('\n');

      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.2,
      });

      const text = typeof response === 'string' ? response : (response as { text: string }).text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.pattern) return null;

      const guardrailText = `When ${parsed.pattern}: ${parsed.guardrail}`;

      // Check for duplicate guardrails
      const existing = await memoryService.searchMemories(
        guardrailText, project, 3, undefined, 'guardrail',
      );
      const isDuplicate = existing.some(e => (e.similarity ?? 0) > 0.85);
      if (isDuplicate) {
        const best = existing[0];
        const conf = ((best.metadata as Record<string, unknown>)?.confidence as number) || 0.5;
        await memoryService.reinforceMemory(best.id, {
          confidence: Math.min(conf + 0.1, 0.99),
          last_triggered_by: taskId,
        });
        this.runtime.logger.info(`[guardrails] Reinforced existing guardrail ${best.id}`);
        return best.id;
      }

      const stored = await memoryService.storeMemory({
        project,
        category: 'guardrail',
        content: guardrailText,
        summary: `[${parsed.severity}] ${guardrailText.substring(0, 150)}`,
        files: [],
        task_id: taskId,
        metadata: {
          pattern: parsed.pattern,
          guardrail: parsed.guardrail,
          severity: parsed.severity,
          confidence: 0.5,
          source: 'failure_extraction',
          source_task: taskId,
          created_at: new Date().toISOString(),
        },
      });

      this.runtime.logger.info(`[guardrails] Created guardrail from task ${taskId.substring(0, 8)}: "${guardrailText.substring(0, 80)}"`);
      return stored?.id || null;
    } catch (err) {
      this.runtime.logger.warn(`[guardrails] Failed to extract guardrail: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async getGuardrails(project: string, description: string, limit = 5): Promise<string[]> {
    const memoryService = this.runtime.getService<MemoryService>('itachi-memory');
    if (!memoryService) return [];

    try {
      const guardrails = await memoryService.searchMemories(
        description, project, limit, undefined, 'guardrail', undefined, 0.4,
      );
      return guardrails
        .filter(g => (g.similarity ?? 0) > 0.3)
        .map(g => g.summary || g.content || '')
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
