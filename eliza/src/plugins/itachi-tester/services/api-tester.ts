import type { TestResult } from '../types.js';

const BASE_URL = 'https://itachisbrainserver.online';
const REQUEST_TIMEOUT_MS = 15_000;

interface Endpoint {
  name: string;
  path: string;
  expectedStatus: number;
  expectJson: boolean;
}

const ENDPOINTS: Endpoint[] = [
  { name: 'health', path: '/api/health', expectedStatus: 200, expectJson: false },
  { name: 'tasks', path: '/api/tasks', expectedStatus: 200, expectJson: true },
  { name: 'memory-recent', path: '/api/memory/recent?project=itachi-memory', expectedStatus: 200, expectJson: true },
];

async function testEndpoint(endpoint: Endpoint): Promise<TestResult> {
  const start = Date.now();
  const url = `${BASE_URL}${endpoint.path}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - start;

    if (response.status !== endpoint.expectedStatus) {
      return {
        name: endpoint.name,
        status: 'fail',
        durationMs,
        message: `Expected HTTP ${endpoint.expectedStatus}, got ${response.status}`,
        metadata: { url, status_code: response.status },
      };
    }

    if (endpoint.expectJson) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          name: endpoint.name,
          status: 'fail',
          durationMs,
          message: 'Response is not valid JSON',
          metadata: { url, status_code: response.status },
        };
      }
      const isArray = Array.isArray(body);
      const isObject = body !== null && typeof body === 'object';
      if (!isArray && !isObject) {
        return {
          name: endpoint.name,
          status: 'fail',
          durationMs,
          message: `Expected JSON object or array, got ${typeof body}`,
        };
      }
    }

    return {
      name: endpoint.name,
      status: 'pass',
      durationMs,
      message: `HTTP ${response.status} in ${durationMs}ms`,
      metadata: { url, status_code: response.status },
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    return {
      name: endpoint.name,
      status: 'fail',
      durationMs,
      message: isTimeout
        ? `Timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : err instanceof Error ? err.message : String(err),
      metadata: { url },
    };
  }
}

export async function runAPITests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const endpoint of ENDPOINTS) {
    const result = await testEndpoint(endpoint);
    results.push(result);
  }
  return results;
}
