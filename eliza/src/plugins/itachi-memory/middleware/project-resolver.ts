/**
 * Resolve the project identifier from an incoming request.
 *
 * Checks (in order):
 *  1. `x-project` header
 *  2. `project` query parameter
 *
 * Returns null if no project could be determined.
 */
export function resolveProject(req: any): string | null {
  const headers = req.headers || {};
  const headerVal = headers['x-project'];
  if (typeof headerVal === 'string' && headerVal.length > 0) return headerVal;

  const query = req.query || {};
  const queryVal = query.project;
  if (typeof queryVal === 'string' && queryVal.length > 0) return queryVal;

  return null;
}
