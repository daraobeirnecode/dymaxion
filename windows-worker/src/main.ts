// Dymaxion Windows Worker — HTTP server on 0.0.0.0:4444 (firewall rule from
// install.ps1 restricts to Private + Domain profiles). All endpoints behind
// shared-secret Bearer auth.
//
//   GET  /health          readiness + capability report
//   POST /arcpy/run       execute an arcpy script in arcgispro-py3
//   POST /pro-cli/run     invoke CLI-Anything-Arcgis-Pro
//   POST /files/upload    shuttle a file in    (?run_id=&name=)
//   GET  /files/download  shuttle a file out   (?run_id=&name=)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isAuthorized } from './auth.js';
import { healthReport } from './health.js';
import { runArcpyScript, type ArcpyRunRequest } from './arcpy-runner.js';
import { runProCli, type ProCliRunRequest } from './pro-cli-runner.js';
import { handleUpload, handleDownload } from './file-shuttler.js';
import { log } from './logger.js';

const PORT = Number(process.env.WORKER_PORT ?? 4444);

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += String(c)));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
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
      case 'POST /arcpy/run': {
        const body = JSON.parse((await readBody(req)) || '{}') as ArcpyRunRequest;
        if (!body.script) {
          json(res, 400, { error: 'script required' });
          return;
        }
        json(res, 200, await runArcpyScript(body));
        return;
      }
      case 'POST /pro-cli/run': {
        const body = JSON.parse((await readBody(req)) || '{}') as ProCliRunRequest;
        if (!body.operation) {
          json(res, 400, { error: 'operation required' });
          return;
        }
        json(res, 200, await runProCli(body));
        return;
      }
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
