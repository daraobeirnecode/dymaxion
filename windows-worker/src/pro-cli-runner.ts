// POST /pro-cli/run — invoke CLI-Anything-Arcgis-Pro
// (github.com/Jasper0122/CLI-Anything-Arcgis-Pro) in the ArcGIS Pro python
// env. Request carries an operation name + operation-specific parameters.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { arcgisProPython, proCliDir, jobStarted, jobFinished } from './health.js';
import { scopeViolations, type RunResponse } from './arcpy-runner.js';
import { log } from './logger.js';

export interface ProCliRunRequest {
  operation: string;
  timeout_seconds?: number;
  denied_paths?: string[];
  [param: string]: unknown;
}

export async function runProCli(req: ProCliRunRequest): Promise<RunResponse> {
  const started = Date.now();
  const cliDir = proCliDir();
  const entry = join(cliDir, 'main.py');
  if (!existsSync(entry)) {
    return {
      status: 'error',
      stdout: '',
      stderr: `CLI-Anything-Arcgis-Pro not found at ${cliDir} — re-run install.ps1`,
      duration_seconds: 0,
    };
  }

  const { operation, timeout_seconds, denied_paths, ...params } = req;
  const paramJson = JSON.stringify(params);
  const violations = scopeViolations(paramJson, denied_paths);
  if (violations.length) {
    return {
      status: 'error',
      stdout: '',
      stderr: `execution scope violation: ${violations.join(', ')}`,
      duration_seconds: 0,
    };
  }

  jobStarted();
  log.info('pro-cli run started', { operation });
  try {
    return await new Promise<RunResponse>((resolve) => {
      execFile(
        arcgisProPython(),
        [entry, operation, '--params', paramJson],
        { timeout: (timeout_seconds ?? 120) * 1000, cwd: cliDir, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({
            status: error ? 'error' : 'success',
            stdout,
            stderr: error ? `${stderr}\n${error.message}` : stderr,
            duration_seconds: Math.round((Date.now() - started) / 1000),
            exit_code: error && 'code' in error ? (error.code as number | null) : 0,
          });
        },
      );
    });
  } finally {
    jobFinished();
    log.info('pro-cli run finished', { operation });
  }
}
