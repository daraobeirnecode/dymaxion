// Rolling-file + console logger. Zero dependencies so the worker installs
// with nothing beyond Node itself.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LOG_DIR = process.env.WORKER_LOG_DIR ?? join(process.cwd(), 'logs');
mkdirSync(LOG_DIR, { recursive: true });

function write(level: string, msg: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    msg,
    ...extra,
  });
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(LOG_DIR, `worker-${day}.log`), line + '\n');
  } catch {
    /* console still has it */
  }
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => write('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write('error', msg, extra),
};
