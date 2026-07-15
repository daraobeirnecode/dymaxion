// Shared-secret Bearer auth. Every endpoint requires
// Authorization: Bearer <SHARED_WORKER_SECRET>; optionally restrict callers
// to ALLOWED_RUNTIME_HOSTS.

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { log } from './logger.js';

export function isAuthorized(req: IncomingMessage): boolean {
  const secret = process.env.SHARED_WORKER_SECRET ?? '';
  if (!secret) {
    log.error('SHARED_WORKER_SECRET not set — refusing all requests');
    return false;
  }
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    log.warn('rejected request: bad secret', { remote: req.socket.remoteAddress });
    return false;
  }

  const allowed = (process.env.ALLOWED_RUNTIME_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (allowed.length) {
    const remote = req.socket.remoteAddress ?? '';
    if (!allowed.some((h) => remote.includes(h))) {
      log.warn('rejected request: host not allowlisted', { remote });
      return false;
    }
  }
  return true;
}
