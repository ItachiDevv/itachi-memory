import { describe, it, expect } from 'vitest';
import { parseReport } from '../plugins/itachi-tasks/services/task-orchestrator';

describe('parseReport', () => {
  it('parses a success report', () => {
    const output = `Some Claude Code output here...
===ITACHI_REPORT===
status: success
approach: direct
criteria_results:
  - "crontab -l shows entry": pass
  - "script runs": pass
summary: Set up HN scraper cron job.
learned:
  - Linux cron jobs run as the creating user.
  - HN firebase API returns JSON.
===END_REPORT===`;

    const report = parseReport(output);
    expect(report).not.toBeNull();
    expect(report!.status).toBe('success');
    expect(report!.approach).toBe('direct');
    expect(report!.criteriaResults).toHaveLength(2);
    expect(report!.criteriaResults[0].criterion).toBe('crontab -l shows entry');
    expect(report!.criteriaResults[0].passed).toBe(true);
    expect(report!.learned).toHaveLength(2);
    expect(report!.summary).toContain('HN scraper');
  });

  it('parses a failed report with failure reasons', () => {
    const output = `===ITACHI_REPORT===
status: failed
approach: direct
criteria_results:
  - "tests pass": fail — 3 tests failed with timeout
summary: Tried to fix tests but hit timeout issues.
learned:
  - Tests need longer timeout in CI environment.
===END_REPORT===`;

    const report = parseReport(output);
    expect(report!.status).toBe('failed');
    expect(report!.criteriaResults[0].passed).toBe(false);
    expect(report!.criteriaResults[0].reason).toContain('timeout');
  });

  it('parses a blocked report', () => {
    const output = `===ITACHI_REPORT===
status: blocked
approach: direct
blocked_reason: About to delete production database — need confirmation
summary: Ready to proceed but need approval for destructive action.
learned:
===END_REPORT===`;

    const report = parseReport(output);
    expect(report!.status).toBe('blocked');
    expect(report!.blockedReason).toContain('delete production');
  });

  it('returns null when no report block found', () => {
    const output = 'Just some random output without a report';
    expect(parseReport(output)).toBeNull();
  });
});
