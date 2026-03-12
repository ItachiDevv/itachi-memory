// eliza/src/plugins/itachi-tasks/services/session-driver.ts
import type { IAgentRuntime } from '@elizaos/core';
import type { ParsedChunk } from '../shared/parsed-chunks.js';
import type { TelegramTopicsService } from './telegram-topics.js';
import type { InteractiveSession } from './ssh-service.js';
import { wrapStreamJsonInput } from '../actions/interactive-session.js';

export interface SessionDriverConfig {
  taskId: string;
  project: string;
  description: string;
  topicId: number;
  handle: InteractiveSession;
  runtime: IAgentRuntime;
  topicsService?: TelegramTopicsService;
  workspace: string;
  sshTarget: string;
}

type SessionPhase = 'initial' | 'working' | 'verifying' | 'waiting_human' | 'done';

/**
 * SessionDriver watches a multi-turn Claude Code session and drives it forward.
 *
 * Lifecycle:
 * 1. Initial prompt sent (by executor) → Claude works
 * 2. Driver watches output for completion signals
 * 3. On apparent completion → sends verification prompt (build, test)
 * 4. On verification pass → signals done
 * 5. On verification fail → sends fix prompt, iterates (max 3 rounds)
 * 6. On confusion/stuck → escalates to Telegram
 */
export class SessionDriver {
  private config: SessionDriverConfig;
  private phase: SessionPhase = 'initial';
  private verifyAttempts = 0;
  private maxVerifyAttempts = 3;
  private turnsSinceLastAction = 0;
  private resultTurnCount = 0;
  private lastAssistantText = '';
  private completionDetected = false;
  private hasToolUsage = false;

  constructor(config: SessionDriverConfig) {
    this.config = config;
  }

  /** Called by the executor for every parsed chunk from Claude's output */
  onChunk(chunk: ParsedChunk): void {
    if (chunk.kind === 'text') {
      this.lastAssistantText = chunk.text;
      this.turnsSinceLastAction++;

      // Track if Claude is actually doing work
      if (chunk.text.includes('Edit') || chunk.text.includes('Write') ||
          chunk.text.includes('Bash') || chunk.text.includes('committed')) {
        this.hasToolUsage = true;
      }
    }

    // AskUserQuestion from Claude → escalate to Telegram
    if (chunk.kind === 'ask_user') {
      this.escalateQuestion(chunk.question, chunk.options || []);
      return;
    }
  }

  /**
   * Called when a turn completes (Claude stops outputting).
   * Decides whether to send a follow-up, request verification, or let it finish.
   */
  async onTurnComplete(): Promise<void> {
    this.resultTurnCount++;
    const text = this.lastAssistantText.toLowerCase();
    this.log(`Turn ${this.resultTurnCount} complete (phase=${this.phase}, hasTools=${this.hasToolUsage}): "${text.substring(0, 100)}"`);

    // Broad completion detection — matches common Claude phrasing
    const isCompletion = /\b(committed|completed|finished|done|ready|implemented|created|added|pushed|merged|all set)\b/.test(text)
      && !/\b(not done|not finished|not ready|isn't done|haven't)\b/.test(text);

    const isError = text.includes('error') && (text.includes('failed') || text.includes('cannot') || text.includes('unable'));
    const isBlocked = text.includes('blocked') || text.includes('need access') || text.includes('permission denied');
    const isQuestion = text.includes('?') && (text.includes('should i') || text.includes('would you') || text.includes('do you want'));

    if (this.phase === 'initial' || this.phase === 'working') {
      if (isCompletion && this.hasToolUsage && !this.completionDetected) {
        this.completionDetected = true;
        this.phase = 'verifying';
        await this.sendVerification();
        return;
      }
      if (isBlocked || isQuestion) {
        await this.escalateToTelegram(this.lastAssistantText);
        return;
      }
      if (isError && this.phase === 'working') {
        this.turnsSinceLastAction = 0;
        return;
      }

      // Safety net: if we've had 3+ result turns with tool usage and no explicit
      // completion signal, assume Claude is done and skip to verification
      if (this.resultTurnCount >= 3 && this.hasToolUsage && !this.completionDetected) {
        this.log(`Safety net: ${this.resultTurnCount} turns with tool usage — triggering verification`);
        this.completionDetected = true;
        this.phase = 'verifying';
        await this.sendVerification();
        return;
      }

      this.phase = 'working';
    }

    if (this.phase === 'verifying') {
      const verifyFailed = text.includes('error') || text.includes('failed') ||
                           text.includes('FAIL') || text.includes('test failed');

      if (!verifyFailed) {
        this.phase = 'done';
        this.log('Verification passed — marking done');
        return;
      }

      if (this.verifyAttempts < this.maxVerifyAttempts) {
        await this.sendFixPrompt();
        return;
      }

      await this.escalateToTelegram(
        `Verification failed after ${this.verifyAttempts} attempts. Last output:\n${this.lastAssistantText.substring(0, 500)}`
      );
      this.phase = 'done';
    }
  }

  /** Send build + test verification prompt to Claude */
  private async sendVerification(): Promise<void> {
    this.verifyAttempts++;
    const msg = [
      'Before we wrap up, verify the changes work:',
      '1. Build the project (if applicable)',
      '2. Run existing tests',
      '3. If you wrote new code with clear test scenarios, write a quick test',
      '4. Report the results',
      '',
      'If everything passes, commit and you\'re done. If something fails, fix it.',
    ].join('\n');

    this.sendToSession(msg);
    this.log(`Sent verification prompt (attempt ${this.verifyAttempts}/${this.maxVerifyAttempts})`);
  }

  /** Send a fix prompt after verification failure */
  private async sendFixPrompt(): Promise<void> {
    this.phase = 'working';
    this.completionDetected = false;

    const msg = 'The build or tests failed. Fix the issues and try again. Focus on the errors shown above.';
    this.sendToSession(msg);
    this.log('Sent fix prompt after verification failure');
  }

  /** Escalate a question from Claude to Telegram */
  private async escalateQuestion(question: string, options: string[]): Promise<void> {
    this.phase = 'waiting_human';
    const { topicsService, topicId } = this.config;
    if (!topicsService) return;

    const text = `**Claude is asking:**\n${question}\n\n_Reply in this topic to answer._`;
    await topicsService.sendToTopic(topicId, text);
    this.log(`Escalated question to Telegram: "${question.substring(0, 80)}"`);
  }

  /** Escalate to Telegram when stuck or confused */
  private async escalateToTelegram(context: string): Promise<void> {
    this.phase = 'waiting_human';
    const { topicsService, topicId, taskId } = this.config;
    if (!topicsService) return;

    const shortId = taskId.substring(0, 8);
    const text = `**Task ${shortId} needs input:**\n${context.substring(0, 1000)}\n\n_Reply in this topic to continue._`;
    await topicsService.sendToTopic(topicId, text);
    this.log(`Escalated to Telegram: "${context.substring(0, 100)}"`);
  }

  /** Pipe a user message to the Claude session's stdin */
  private sendToSession(text: string): void {
    const { handle } = this.config;
    try {
      handle.write(wrapStreamJsonInput(text));
      this.turnsSinceLastAction = 0;
    } catch (err) {
      this.log(`Failed to write to session: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Forward human input from Telegram to the session */
  onHumanInput(text: string): void {
    if (this.phase === 'waiting_human') {
      this.phase = 'working';
    }
    this.sendToSession(text);
    this.log(`Forwarded human input: "${text.substring(0, 80)}"`);
  }

  /** Generate and send a completion summary to the main Telegram chat */
  async sendCompletionSummary(status: string, filesChanged: string[], prUrl?: string): Promise<void> {
    const { topicsService, taskId, project, description } = this.config;
    if (!topicsService) return;

    const shortId = taskId.substring(0, 8);
    const emoji = status === 'completed' ? '✅' : status === 'timeout' ? '⏱️' : '❌';

    const lines = [
      `${emoji} **Task ${shortId}** — ${description.substring(0, 80)}`,
      `Project: ${project} | Status: ${status}`,
    ];
    if (filesChanged.length > 0) {
      lines.push(`Files: ${filesChanged.length} changed`);
    }
    if (prUrl) {
      lines.push(`PR: ${prUrl}`);
    }
    if (this.verifyAttempts > 0) {
      lines.push(`Verification: ${this.verifyAttempts} round(s)`);
    }

    try {
      await topicsService.sendMessageWithKeyboard(lines.join('\n'), []);
    } catch { /* non-critical */ }
  }

  getPhase(): SessionPhase { return this.phase; }
  isDone(): boolean { return this.phase === 'done'; }

  private log(msg: string): void {
    const shortId = this.config.taskId.substring(0, 8);
    this.config.runtime.logger.info(`[session-driver:${shortId}] ${msg}`);
  }
}
