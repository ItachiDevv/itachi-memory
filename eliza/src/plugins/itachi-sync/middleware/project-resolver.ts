/**
 * Resolves project name from request in priority order:
 * 1. X-Itachi-Project header
 * 2. ?project= query parameter
 * 3. body.project
 * 4. null (caller must handle)
 */
export function resolveProject(
  req: {
    headers: Record<string, string | string[] | undefined>;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  }
): string | null {
  // 1. Header
  const header = req.headers['x-itachi-project'];
  if (typeof header === 'string' && header.length > 0) {
    return header;
  }

  // 2. Query parameter
  const queryProject = req.query?.project;
  if (typeof queryProject === 'string' && queryProject.length > 0) {
    return queryProject;
  }

  // 3. Body
  const bodyProject = req.body?.project;
  if (typeof bodyProject === 'string' && bodyProject.length > 0) {
    return bodyProject;
  }

  return null;
}
