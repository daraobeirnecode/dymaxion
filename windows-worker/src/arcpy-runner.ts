// POST /arcpy/run — write the script to a temp file and execute it in the
// ArcGIS Pro python env (arcgispro-py3). Scripts are confined to SHARED_DIR:
// any absolute path in the script outside the share is rejected pre-execution
// (the employer boundary from the main runtime is also enforced here).

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { arcgisProPython, jobStarted, jobFinished } from './health.js';
import { log } from './logger.js';

export interface ArcpyRunRequest {
  script: string;
  inputs?: Record<string, unknown>;
  timeout_seconds?: number;
  run_id?: string;
  denied_paths?: string[]; // employer boundary passthrough from the runtime
}

export interface RunResponse {
  status: 'success' | 'error';
  stdout: string;
  stderr: string;
  duration_seconds: number;
  outputs?: Record<string, unknown>;
  exit_code?: number | null;
}

function sharedDir(): string {
  return process.env.SHARED_DIR ?? 'C:\\dymaxion-shared';
}

/** Reject scripts referencing absolute paths outside the shared dir. */
export function scopeViolations(script: string, deniedPaths: string[] = []): string[] {
  const violations: string[] = [];
  const share = sharedDir().toLowerCase().replace(/\\+$/, '');
  const pathRe = /(?:[A-Za-z]:\\|\\\\)[^\s'")\]]*/g;
  for (const match of script.match(pathRe) ?? []) {
    const normalized = match.toLowerCase();
    if (!normalized.startsWith(share) && !normalized.startsWith('c:\\program files\\arcgis')) {
      violations.push(match);
    }
  }
  for (const denied of deniedPaths) {
    if (script.toLowerCase().includes(denied.toLowerCase().replace(/\*/g, ''))) {
      violations.push(`denied path pattern: ${denied}`);
    }
  }
  return violations;
}

export async function runArcpyScript(req: ArcpyRunRequest): Promise<RunResponse> {
  const started = Date.now();
  const violations = scopeViolations(req.script, req.denied_paths);
  if (violations.length) {
    return {
      status: 'error',
      stdout: '',
      stderr: `execution scope violation — paths outside ${sharedDir()}: ${violations.join(', ')}`,
      duration_seconds: 0,
    };
  }

  const dir = mkdtempSync(join(tmpdir(), 'dymaxion-arcpy-'));
  const scriptPath = join(dir, 'script.py');
  const inputsPath = join(dir, 'inputs.json');
  writeFileSync(scriptPath, req.script);
  writeFileSync(inputsPath, JSON.stringify(req.inputs ?? {}));

  jobStarted();
  log.info('arcpy run started', { run_id: req.run_id });
  try {
    return await new Promise<RunResponse>((resolve) => {
      execFile(
        arcgisProPython(),
        [scriptPath],
        {
          timeout: (req.timeout_seconds ?? 300) * 1000,
          env: { ...process.env, DYMAXION_INPUTS: inputsPath, DYMAXION_SHARED: sharedDir() },
          maxBuffer: 32 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const duration = Math.round((Date.now() - started) / 1000);
          // Convention: scripts may print a final line `DYMAXION_OUTPUTS: {...json...}`
          let outputs: Record<string, unknown> | undefined;
          const m = stdout.match(/^DYMAXION_OUTPUTS:\s*(\{.*\})\s*$/m);
          if (m) {
            try {
              outputs = JSON.parse(m[1]) as Record<string, unknown>;
            } catch {
              /* leave undefined */
            }
          }
          resolve({
            status: error ? 'error' : 'success',
            stdout,
            stderr: error ? `${stderr}\n${error.message}` : stderr,
            duration_seconds: duration,
            outputs,
            exit_code: error && 'code' in error ? (error.code as number | null) : 0,
          });
        },
      );
    });
  } finally {
    jobFinished();
    rmSync(dir, { recursive: true, force: true });
    log.info('arcpy run finished', { run_id: req.run_id });
  }
}
