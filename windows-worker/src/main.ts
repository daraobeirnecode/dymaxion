// Dymaxion Windows Worker Phase 0 scaffold. Health and authenticated file
// shuttle endpoints remain for build/transport verification. Prompt-addressable
// ArcPy and ArcGIS Pro execution routes are permanently disabled (HTTP 410)
// pending an allowlisted job catalog and independent security testing.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isAuthorized } from './auth.js';
import { healthReport } from './health.js';
import { handleUpload, handleDownload } from './file-shuttler.js';
import { log } from './logger.js';

const PORT = Number(process.env.WORKER_PORT ?? 4444);

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    if (!isAuthorized(req)) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://worker');
    const route = `${req.method} ${url.pathname}`;

    switch (route) {
      case 'GET /health':
        json(res, 200, await healthReport());
        return;
      case 'POST /arcpy/run':
      case 'POST /pro-cli/run':
        json(res, 410, {
          error:
            'Windows execution is disabled in Phase 0 pending an allowlisted job catalog and independent security testing.',
        });
        return;
      case 'POST /files/upload':
        await handleUpload(req, res, url.searchParams);
        return;
      case 'GET /files/download':
        await handleDownload(res, url.searchParams);
        return;
      default:
        json(res, 404, { error: `no route: ${route}` });
    }
  } catch (err) {
    log.error('request failed', { error: String(err) });
    if (!res.headersSent) json(res, 500, { error: String(err) });
    else res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log.info(`dymaxion windows worker listening on 0.0.0.0:${PORT}`);
});
