export interface HealthStatus {
  uptime: number;
  memoryUsage: NodeJS.MemoryUsage;
  timestamp: string;
}

export function getHealthStatus(): HealthStatus {
  return {
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  };
}
