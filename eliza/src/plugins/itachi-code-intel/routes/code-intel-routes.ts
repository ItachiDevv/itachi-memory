import type { Route, IAgentRuntime } from '@elizaos/core';
import { ModelType, MemoryType } from '@elizaos/core';
import { CodeIntelService } from '../services/code-intel-service.js';
import { MemoryService } from '../../itachi-memory/services/memory-service.js';
import { checkAuth, sanitizeError, truncate, MAX_LENGTHS } from '../../itachi-sync/utils.js';
import { resolveProject } from '../../itachi-sync/middleware/project-resolver.js';

/**
 * RLM Bridge: Maps session insight categories to RLM management-lesson categories.
 *
 * Only a subset of insight categories are promoted to the RLM (Recursive Learning Model).
 * The RLM's lessons provider feeds past lessons into Itachi's Telegram LLM context to
 * improve future decisions. Not every session insight is useful for this:
 *
 * - `preference` → `user-preference`: How the user likes things done (naming, tooling, workflow)
 * - `learning`   → `error-handling`:  What went wrong and how it was resolved
 * - `decision`   → `project-selection`: Choices about approach, scope, or direction
 *
 * Excluded from RLM:
 * - `pattern`: Project-specific coding patterns — useful as itachi_memories search context,
 *   but not actionable guidance for Itachi's management decisions.
 * - `architecture`: Structural choices — important project facts, but the RLM lessons
 *   provider works better with reusable heuristics, not one-off architectural records.
 * - `bugfix`: Routine fixes rarely produce reusable management lessons.
 *
 * Threshold: significance >= 0.7 (the "technical decisions / architectural choices" tier).
 * This avoids polluting the RLM with routine work while capturing meaningful learnings.
 */
const RLM_CATEGORY_MAP: Record<string, string> = {
  preference: 'user-preference',
  learning: 'error-handling',
  decision: 'project-selection',
};
const RLM_SIGNIFICANCE_THRESHOLD = 0.7;

export const codeIntelRoutes: Route[] = [
  // Receive per-edit data from after-edit hooks
  {
    type: 'POST',
    path: '/api/session/edit',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const project = resolveProject(req) || req.body.project;
        const {
          session_id, file_path, edit_type, language,
          diff_content, lines_added, lines_removed,
          tool_name, branch, task_id,
        } = req.body;

        if (!session_id || !file_path) {
          res.status(400).json({ error: 'session_id and file_path required' });
          return;
        }
        if (!project) {
          res.status(400).json({ error: 'project required (header, query, or body)' });
          return;
        }

        const service = rt.getService<CodeIntelService>('itachi-code-intel');
        if (!service) {
          res.status(503).json({ error: 'Code intel service not available' });
          return;
        }

        await service.storeEdit({
          session_id,
          project: truncate(project, MAX_LENGTHS.project),
          file_path: truncate(file_path, MAX_LENGTHS.file_path),
          edit_type: edit_type || 'modify',
          language,
          diff_content: diff_content ? truncate(diff_content, 10240) : undefined,
          lines_added: typeof lines_added === 'number' ? lines_added : 0,
          lines_removed: typeof lines_removed === 'number' ? lines_removed : 0,
          tool_name,
          branch: branch ? truncate(branch, MAX_LENGTHS.branch) : undefined,
          task_id,
        });

        res.json({ success: true });
      } catch (error) {
        (runtime as IAgentRuntime).logger.error('Session edit store error:', error instanceof Error ? error.message : String(error));
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },

  // Receive session summary from session-end / orchestrator
  {
    type: 'POST',
    path: '/api/session/complete',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const project = resolveProject(req) || req.body.project;
        const {
          session_id, task_id, started_at, ended_at,
          duration_ms, exit_reason, files_changed,
          total_lines_added, total_lines_removed,
          tools_used, summary, branch, orchestrator_id,
        } = req.body;

        if (!session_id) {
          res.status(400).json({ error: 'session_id required' });
          return;
        }
        if (!project) {
          res.status(400).json({ error: 'project required (header, query, or body)' });
          return;
        }

        const service = rt.getService<CodeIntelService>('itachi-code-intel');
        if (!service) {
          res.status(503).json({ error: 'Code intel service not available' });
          return;
        }

        await service.storeSessionComplete({
          session_id,
          project: truncate(project, MAX_LENGTHS.project),
          task_id,
          started_at,
          ended_at: ended_at || new Date().toISOString(),
          duration_ms,
          exit_reason,
          files_changed,
          total_lines_added,
          total_lines_removed,
          tools_used,
          summary: summary ? truncate(summary, MAX_LENGTHS.summary) : undefined,
          branch: branch ? truncate(branch, MAX_LENGTHS.branch) : undefined,
          orchestrator_id,
        });

        res.json({ success: true });
      } catch (error) {
        (runtime as IAgentRuntime).logger.error('Session complete store error:', error instanceof Error ? error.message : String(error));
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },

  // Return assembled briefing for session-start injection
  {
    type: 'GET',
    path: '/api/session/briefing',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const project = resolveProject(req);
        const { branch } = req.query as Record<string, string>;

        if (!project) {
          res.status(400).json({ error: 'project required (header or query)' });
          return;
        }

        const service = rt.getService<CodeIntelService>('itachi-code-intel');
        if (!service) {
          res.status(503).json({ error: 'Code intel service not available' });
          return;
        }

        const briefing = await service.generateBriefing(project, branch);
        res.json(briefing);
      } catch (error) {
        (runtime as IAgentRuntime).logger.error('Briefing generation error:', error instanceof Error ? error.message : String(error));
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },

  // Return project-specific rules (learnings) for MEMORY.md injection
  {
    type: 'GET',
    path: '/api/project/learnings',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const project = resolveProject(req);
        const { limit: limitStr, min_confidence: minConfStr } = req.query as Record<string, string>;

        if (!project) {
          res.status(400).json({ error: 'project required (header or query)' });
          return;
        }

        const limit = Math.min(parseInt(limitStr, 10) || 15, 50);
        const minConfidence = parseFloat(minConfStr) || 0.3;

        const memoryService = rt.getService<MemoryService>('itachi-memory');
        if (!memoryService) {
          res.status(503).json({ error: 'Memory service not available' });
          return;
        }

        const supabase = memoryService.getSupabase();
        const { data, error } = await supabase
          .from('itachi_memories')
          .select('id, summary, metadata, created_at')
          .eq('project', project)
          .eq('category', 'project_rule')
          .order('created_at', { ascending: false })
          .limit(100);

        if (error) throw error;

        const rules = (data || [])
          .map(row => {
            const meta = (row.metadata as Record<string, unknown>) || {};
            const confidence = typeof meta.confidence === 'number' ? meta.confidence : 0.5;
            const timesReinforced = typeof meta.times_reinforced === 'number' ? meta.times_reinforced : 1;
            return {
              id: row.id,
              rule: row.summary,
              confidence,
              times_reinforced: timesReinforced,
              last_reinforced: meta.last_reinforced as string || row.created_at,
              score: confidence * timesReinforced,
            };
          })
          .filter(r => r.confidence >= minConfidence)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map(({ score: _score, ...rest }) => rest);

        res.json({ project, rules });
      } catch (error) {
        (runtime as IAgentRuntime).logger.error('Project learnings error:', error instanceof Error ? error.message : String(error));
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },

  // Extract insights from a Claude Code session transcript
  {
    type: 'POST',
    path: '/api/session/extract-insights',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const project = resolveProject(req) || req.body.project;
        const {
          session_id, conversation_text, files_changed,
          summary, duration_ms,
        } = req.body;

        if (!conversation_text || conversation_text.length < 50) {
          res.status(400).json({ error: 'conversation_text required (min 50 chars)' });
          return;
        }
        if (!project) {
          res.status(400).json({ error: 'project required (header, query, or body)' });
          return;
        }

        const memoryService = rt.getService<MemoryService>('itachi-memory');
        if (!memoryService) {
          res.status(503).json({ error: 'Memory service not available' });
          return;
        }

        const durationMin = duration_ms ? Math.round(duration_ms / 60000) : 0;
        const filesStr = Array.isArray(files_changed) ? files_changed.join(', ') : 'unknown';
        const safeText = truncate(conversation_text, 4000);

        const prompt = `Analyze this Claude Code session conversation and extract insights.

Project: ${truncate(project, MAX_LENGTHS.project)}
Duration: ${durationMin}min
Files changed: ${filesStr}
Session summary: ${summary ? truncate(summary, MAX_LENGTHS.summary) : 'none'}

Conversation:
${safeText}

Score significance 0.0-1.0:
0.0-0.2: Trivial changes, greetings
0.3-0.5: Bug fixes, minor features, routine work
0.6-0.8: Technical decisions, architectural choices, important patterns
0.9-1.0: Critical decisions, project pivots, major refactors

Extract key insights as categorized items. Valid categories: decision, pattern, bugfix, architecture, preference, learning.

Also extract project-specific rules — prescriptive learnings that should inform all future work on this project. These are things like conventions, gotchas, tool preferences, testing requirements, or dependency constraints. Rules should be short, actionable statements. Only include rules if there's clear evidence in the conversation.

Respond ONLY with valid JSON, no markdown fences:
{"significance": 0.7, "insights": [{"category": "decision", "summary": "..."}], "rules": [{"rule": "Always use yarn, not npm", "confidence": 0.8}]}`;

        const result = await rt.useModel(ModelType.TEXT_SMALL, {
          prompt,
          temperature: 0.2,
        });

        const raw = typeof result === 'string' ? result : String(result);
        let parsed: {
          significance: number;
          insights: Array<{ category: string; summary: string }>;
          rules?: Array<{ rule: string; confidence: number }>;
        };
        try {
          parsed = JSON.parse(raw.trim());
        } catch {
          rt.logger.warn('[extract-insights] Unparseable LLM output');
          res.status(422).json({ error: 'LLM returned unparseable response' });
          return;
        }

        if (typeof parsed.significance !== 'number' || !Array.isArray(parsed.insights)) {
          res.status(422).json({ error: 'Invalid LLM response structure' });
          return;
        }

        const significance = Math.max(0, Math.min(1, parsed.significance));

        // Skip storing if trivial
        if (significance < 0.25 || parsed.insights.length === 0) {
          res.json({ success: true, significance, insights_stored: 0 });
          return;
        }

        let stored = 0;
        for (const insight of parsed.insights.slice(0, 10)) {
          if (!insight.summary || insight.summary.length < 10) continue;
          try {
            await memoryService.storeMemory({
              project: truncate(project, MAX_LENGTHS.project),
              category: truncate(insight.category || 'session', MAX_LENGTHS.category),
              content: `[Session ${session_id || 'unknown'}] ${insight.summary}`,
              summary: truncate(insight.summary, MAX_LENGTHS.summary),
              files: Array.isArray(files_changed) ? files_changed.slice(0, 50) : [],
              metadata: { significance, source: 'session', session_id },
            });
            stored++;
          } catch (e) {
            rt.logger.warn(`[extract-insights] Failed to store insight: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // RLM Bridge: promote qualifying insights to ElizaOS native CUSTOM memories
        // so the lessons provider can surface them in Telegram conversations.
        let rlmPromoted = 0;
        if (significance >= RLM_SIGNIFICANCE_THRESHOLD) {
          for (const insight of parsed.insights.slice(0, 10)) {
            const rlmCategory = RLM_CATEGORY_MAP[insight.category];
            if (!rlmCategory || !insight.summary || insight.summary.length < 10) continue;
            try {
              await rt.createMemory({
                type: MemoryType.CUSTOM,
                content: { text: insight.summary },
                metadata: {
                  type: 'management-lesson',
                  category: rlmCategory,
                  confidence: significance,
                  outcome: 'success' as const,
                  source: 'session-insights',
                  session_id,
                  project: truncate(project, MAX_LENGTHS.project),
                  extracted_at: new Date().toISOString(),
                },
              });
              rlmPromoted++;
            } catch (e) {
              rt.logger.warn(`[extract-insights] RLM bridge failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          if (rlmPromoted > 0) {
            rt.logger.info(`[extract-insights] Promoted ${rlmPromoted} insights to RLM (management-lesson)`);
          }
        }

        // Project Rules: extract and store/reinforce project-specific rules
        let rulesStored = 0;
        let rulesReinforced = 0;
        if (Array.isArray(parsed.rules) && parsed.rules.length > 0) {
          const projKey = truncate(project, MAX_LENGTHS.project);
          for (const ruleEntry of parsed.rules.slice(0, 10)) {
            if (!ruleEntry.rule || ruleEntry.rule.length < 10) continue;
            const ruleConfidence = typeof ruleEntry.confidence === 'number'
              ? Math.max(0, Math.min(1, ruleEntry.confidence))
              : 0.6;

            try {
              // Search for existing similar rules in this project
              const existing = await memoryService.searchMemories(
                ruleEntry.rule, projKey, 3, undefined, 'project_rule'
              );

              const bestMatch = existing.length > 0 ? existing[0] : null;
              const matchSimilarity = bestMatch?.similarity ?? 0;

              if (bestMatch && matchSimilarity > 0.85) {
                // Reinforce existing rule
                await memoryService.reinforceMemory(bestMatch.id, {
                  confidence: Math.max(
                    ruleConfidence,
                    (bestMatch.metadata as Record<string, unknown>)?.confidence as number || 0.5
                  ),
                });
                // Update wording if new version is longer/more specific
                if (ruleEntry.rule.length > (bestMatch.summary?.length || 0)) {
                  await memoryService.updateMemorySummary(bestMatch.id, ruleEntry.rule);
                }
                rulesReinforced++;
              } else {
                // Store as new project rule
                await memoryService.storeMemory({
                  project: projKey,
                  category: 'project_rule',
                  content: ruleEntry.rule,
                  summary: ruleEntry.rule,
                  files: Array.isArray(files_changed) ? files_changed.slice(0, 50) : [],
                  metadata: {
                    confidence: ruleConfidence,
                    times_reinforced: 1,
                    source: 'session',
                    first_seen: new Date().toISOString(),
                    last_reinforced: new Date().toISOString(),
                    session_id,
                  },
                });
                rulesStored++;
              }
            } catch (e) {
              rt.logger.warn(`[extract-insights] Failed to store/reinforce rule: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          if (rulesStored > 0 || rulesReinforced > 0) {
            rt.logger.info(`[extract-insights] Rules: ${rulesStored} new, ${rulesReinforced} reinforced for ${projKey}`);
          }
        }

        rt.logger.info(`[extract-insights] Stored ${stored} insights (significance=${significance.toFixed(2)}, rlm=${rlmPromoted}, rules=${rulesStored}+${rulesReinforced}r) for ${project}`);
        res.json({ success: true, significance, insights_stored: stored, rlm_promoted: rlmPromoted, rules_stored: rulesStored, rules_reinforced: rulesReinforced });
      } catch (error) {
        (runtime as IAgentRuntime).logger.error('Extract insights error:', error instanceof Error ? error.message : String(error));
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },
];
