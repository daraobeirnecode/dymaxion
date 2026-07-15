// GET /health — readiness + capability report: arcpy availability + Pro
// version, CLI-Anything-Arcgis-Pro presence, disk, load.

import { execFile } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const startedAt = Date.now();

export function arcgisProPython(): string {
  return (
    process.env.ARCGISPRO_PYTHON ??
    'C:\\Program Files\\ArcGIS\\Pro\\bin\\Python\\envs\\arcgispro-py3\\python.exe'
  );
}

export function proCliDir(): string {
  return (
    process.env.PRO_CLI_DIR ??
    `${process.env.USERPROFILE ?? ''}\\.dymaxion\\cli-anything-arcgis-pro`
  );
}

let cachedProVersion: string | null = null;

async function detectProVersion(): Promise<string | undefined> {
  if (cachedProVersion) return cachedProVersion;
  try {
    const { stdout } = await execFileP(
      arcgisProPython(),
      ['-c', 'import arcpy; print(arcpy.GetInstallInfo()["Version"])'],
      { timeout: 60_000 },
    );
    cachedProVersion = stdout.trim();
    return cachedProVersion;
  } catch {
    return undefined;
  }
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  worker_version: string;
  uptime_seconds: number;
  arcpy: { available: boolean; arcgis_pro_version?: string; python_env?: string };
  cli_anything_arcgis_pro: { available: boolean; installed_at?: string };
  disk_free_gb?: number;
  current_load: 'idle' | 'busy';
}

let activeJobs = 0;
export function jobStarted(): void {
  activeJobs += 1;
}
export function jobFinished(): void {
  activeJobs = Math.max(0, activeJobs - 1);
}

export async function healthReport(): Promise<HealthReport> {
  const pythonEnv = arcgisProPython();
  const arcpyAvailable = existsSync(pythonEnv);
  const proVersion = arcpyAvailable ? await detectProVersion() : undefined;
  const cliDir = proCliDir();
  const cliAvailable = existsSync(cliDir);

  let diskFreeGb: number | undefined;
  try {
    const stat = statfsSync(process.env.SHARED_DIR ?? 'C:\\');
    diskFreeGb = Math.round((stat.bavail * stat.bsize) / 1e9);
  } catch {
    /* optional */
  }

  return {
    status: arcpyAvailable ? 'ok' : 'degraded',
    worker_version: '0.1.0',
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    arcpy: {
      available: arcpyAvailable,
      arcgis_pro_version: proVersion,
      python_env: arcpyAvailable ? pythonEnv : undefined,
    },
    cli_anything_arcgis_pro: {
      available: cliAvailable,
      installed_at: cliAvailable ? cliDir : undefined,
    },
    disk_free_gb: diskFreeGb,
    current_load: activeJobs > 0 ? 'busy' : 'idle',
  };
}
