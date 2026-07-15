// Proxies chat messages to the runtime and streams the SSE response through.

export const dynamic = 'force-dynamic';

const RUNTIME_URL = process.env.RUNTIME_URL ?? 'http://dymaxion-runtime:8787';

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${RUNTIME_URL}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // Never buffer — the runtime streams plan/progress/final events.
      cache: 'no-store',
    });
  } catch (e) {
    return Response.json(
      {
        type: 'error',
        text: `Runtime unreachable at ${RUNTIME_URL}: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 }
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return Response.json(
      { type: 'error', text: `Runtime returned HTTP ${upstream.status}: ${detail.slice(0, 500)}` },
      { status: 502 }
    );
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
