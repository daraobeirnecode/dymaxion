// Windows Worker client — ArcGIS Pro CLI + arcpy over HTTP (see
// windows-worker/ and Windows Worker.md). Health-checked every 30s;
// ArcGIS-Pro-dependent skills toggle availability with worker status.

import { logger } from '../observability/logger.js';
import { auditEvent } from '../security/audit.js';

export interface WorkerHealth {
  status: string;
  worker_version: string;
  uptime_seconds: number;
  arcpy: { available: boolean; arcgis_pro_version?: string; python_env?: string };
  cli_anything_arcgis_pro: { available: boolean; installed_at?: string; version?: string };
  disk_free_gb?: number;
  current_load?: string;
}

const HEALTH_INTERVAL_MS = 30_000;

let available = false;
let lastHealth: WorkerHealth | null = null;
let timer: NodeJS.Timeout | null = null;

export function workerConfigured(): boolean {
  return Boolean(process.env.WINDOWS_WORKER_URL);
}

export function workerAvailable(): boolean {
  return available;
}

export function workerHealth(): WorkerHealth | null {
  return lastHealth;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.WINDOWS_WORKER_SECRET ?? ''}`,
    'Content-Type': 'application/json',
  };
}

export async function checkWorkerHealth(): Promise<boolean> {
  if (!workerConfigured()) {
    available = false;
    return false;
  }
  try {
    const res = await fetch(`${process.env.WINDOWS_WORKER_URL}/health`, {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastHealth = (await res.json()) as WorkerHealth;
    const wasAvailable = available;
    available = lastHealth.status === 'ok';
    if (available !== wasAvailable) {
      logger.info({ available }, 'windows worker availability changed');
      await auditEvent('system', { event: 'worker_availability', available });
    }
    return available;
  } catch (err) {
    if (available) {
      logger.warn({ err }, 'windows worker became unreachable — ArcGIS Pro skills disabled');
      await auditEvent('system', { event: 'worker_availability', available: false });
    }
    available = false;
    return false;
  }
}

export function startWorkerHealthLoop(): void {
  if (timer || !workerConfigured()) return;
  void checkWorkerHealth();
  timer = setInterval(() => void checkWorkerHealth(), HEALTH_INTERVAL_MS);
  timer.unref();
}

export function stopWorkerHealthLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export interface WorkerRunResult {
  status: 'success' | 'error';
  stdout: string;
  stderr: string;
  duration_seconds: number;
  outputs?: Record<string, unknown>;
}

async function post(path: string, body: unknown, timeoutSeconds: number): Promise<WorkerRunResult> {
  if (!workerAvailable()) {
    throw new Error(
      'Windows Worker unreachable — try again when the Windows machine is online, or use the arcgis Python API skill as an alternative.',
    );
  }
  const res = await fetch(`${process.env.WINDOWS_WORKER_URL}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((timeoutSeconds + 30) * 1000),
  });
  if (!res.ok) throw new Error(`Windows Worker ${path} failed: HTTP ${res.status}`);
  return (await res.json()) as WorkerRunResult;
}

export async function runArcpy(params: {
  script: string;
  inputs?: Record<string, unknown>;
  timeout_seconds?: number;
  run_id?: string;
}): Promise<WorkerRunResult> {
  await auditEvent('worker_dispatch', { endpoint: '/arcpy/run', run_id: params.run_id }, params.run_id);
  return post('/arcpy/run', { timeout_seconds: 300, ...params }, params.timeout_seconds ?? 300);
}

export async function runProCli(params: {
  operation: string;
  timeout_seconds?: number;
  [key: string]: unknown;
}): Promise<WorkerRunResult> {
  await auditEvent('worker_dispatch', { endpoint: '/pro-cli/run', operation: params.operation });
  return post('/pro-cli/run', { timeout_seconds: 120, ...params }, params.timeout_seconds ?? 120);
}
