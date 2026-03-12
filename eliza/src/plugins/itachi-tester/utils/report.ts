import type { TestRun, TestSuite, TestResult } from '../types.js';

function statusIcon(status: string): string {
  switch (status) {
    case 'pass': return '✅';
    case 'fail': return '❌';
    case 'skip': return '⏭';
    case 'error': return '💥';
    default: return '❓';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatSuite(suite: TestSuite): string {
  const lines: string[] = [];
  const suiteIcon = suite.failCount > 0 || suite.errorCount > 0 ? '❌' : suite.skipCount === suite.results.length ? '⏭' : '✅';
  lines.push(`### ${suiteIcon} ${suite.name} (${formatDuration(suite.durationMs)})`);
  lines.push(`Pass: ${suite.passCount} | Fail: ${suite.failCount} | Skip: ${suite.skipCount} | Error: ${suite.errorCount}`);
  lines.push('');
  for (const r of suite.results) {
    lines.push(`- ${statusIcon(r.status)} **${r.name}** (${formatDuration(r.durationMs)})`);
    if (r.message) lines.push(`  > ${r.message}`);
    if (r.detail) lines.push(`  \`\`\`\n  ${r.detail.substring(0, 300)}\n  \`\`\``);
  }
  return lines.join('\n');
}

export function formatTestRunMarkdown(run: TestRun): string {
  const lines: string[] = [];
  const overallIcon = run.totalFail > 0 || run.totalError > 0 ? '❌' : '✅';
  lines.push(`## ${overallIcon} Itachi System Test Run`);
  lines.push(`**Run ID**: ${run.id}`);
  lines.push(`**Started**: ${run.startedAt}`);
  lines.push(`**Duration**: ${formatDuration(run.durationMs)}`);
  lines.push(`**Summary**: ${run.totalPass} passed / ${run.totalFail} failed / ${run.totalSkip} skipped / ${run.totalError} errors`);
  lines.push('');

  for (const suite of run.suites) {
    lines.push(formatSuite(suite));
    lines.push('');
  }

  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatTestRunTelegram(run: TestRun): string {
  const overallIcon = run.totalFail > 0 || run.totalError > 0 ? '❌' : '✅';
  const lines: string[] = [];
  lines.push(`${overallIcon} <b>Itachi E2E Test Run</b>`);
  lines.push(`Duration: ${escapeHtml(formatDuration(run.durationMs))}`);
  lines.push(`Pass: ${run.totalPass} | Fail: ${run.totalFail} | Skip: ${run.totalSkip} | Error: ${run.totalError}`);
  lines.push('');
  for (const suite of run.suites) {
    const suiteIcon = suite.failCount > 0 || suite.errorCount > 0 ? '❌' : suite.skipCount === suite.results.length ? '⏭' : '✅';
    lines.push(`${suiteIcon} <b>${escapeHtml(suite.name)}</b>: ${suite.passCount}✅ ${suite.failCount}❌ ${suite.skipCount}⏭`);
    // Show failed tests
    for (const r of suite.results) {
      if (r.status === 'fail' || r.status === 'error') {
        lines.push(`  - ${escapeHtml(r.name)}: ${escapeHtml(r.message || 'no detail')}`);
      }
    }
  }
  return lines.join('\n');
}

export function suiteFromResults(name: string, results: TestResult[], durationMs: number): TestSuite {
  return {
    name,
    results,
    durationMs,
    passCount: results.filter(r => r.status === 'pass').length,
    failCount: results.filter(r => r.status === 'fail').length,
    skipCount: results.filter(r => r.status === 'skip').length,
    errorCount: results.filter(r => r.status === 'error').length,
  };
}
