export type TestStatus = 'pass' | 'fail' | 'skip' | 'error';

export interface TestResult {
  name: string;
  status: TestStatus;
  durationMs: number;
  message?: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}

export interface TestSuite {
  name: string;
  results: TestResult[];
  durationMs: number;
  passCount: number;
  failCount: number;
  skipCount: number;
  errorCount: number;
}

export interface TestRun {
  id: string;
  startedAt: string;
  completedAt: string;
  suites: TestSuite[];
  totalPass: number;
  totalFail: number;
  totalSkip: number;
  totalError: number;
  durationMs: number;
}

export interface HistoricalResult {
  testName: string;
  suiteName: string;
  status: TestStatus;
  runId: string;
  runAt: string;
}
