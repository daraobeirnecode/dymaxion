import assert from 'node:assert/strict';
import test from 'node:test';
import { GET } from '../app/api/artifacts/[token]/route';

const TOKEN = `${'a'.repeat(32)}.${'b'.repeat(43)}`;
const AUTH_HEADERS = { 'Tailscale-User-Login': 'operator@example.com' };

async function withProxyEnvironment(run: () => Promise<void>): Promise<void> {
  const previous = {
    identities: process.env.DYMAXION_ADMIN_IDENTITIES,
    internal: process.env.RUNTIME_INTERNAL_TOKEN,
    runtime: process.env.RUNTIME_URL,
  };
  process.env.DYMAXION_ADMIN_IDENTITIES = 'operator@example.com';
  process.env.RUNTIME_INTERNAL_TOKEN = 'test-internal-artifact-token';
  process.env.RUNTIME_URL = 'http://runtime.test:8787/';
  try {
    await run();
  } finally {
    if (previous.identities === undefined) delete process.env.DYMAXION_ADMIN_IDENTITIES;
    else process.env.DYMAXION_ADMIN_IDENTITIES = previous.identities;
    if (previous.internal === undefined) delete process.env.RUNTIME_INTERNAL_TOKEN;
    else process.env.RUNTIME_INTERNAL_TOKEN = previous.internal;
    if (previous.runtime === undefined) delete process.env.RUNTIME_URL;
    else process.env.RUNTIME_URL = previous.runtime;
  }
}

test('artifact proxy requires an authenticated allowlisted admin and a bounded token', async () => {
  await withProxyEnvironment(async () => {
    const unauthorized = await GET(
      new Request(`http://admin/api/artifacts/${TOKEN}`),
      { params: Promise.resolve({ token: TOKEN }) },
    );
    assert.equal(unauthorized.status, 401);

    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetched = true;
      throw new Error('must not fetch');
    };
    try {
      const malformed = await GET(
        new Request('http://admin/api/artifacts/not-a-token', { headers: AUTH_HEADERS }),
        { params: Promise.resolve({ token: 'not-a-token' }) },
      );
      assert.equal(malformed.status, 404);
      assert.equal(fetched, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('artifact proxy forwards only to the configured runtime and copies an allowlist of download headers', async () => {
  await withProxyEnvironment(async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    let suppliedIdentity = '';
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      suppliedIdentity = new Headers(init?.headers).get('x-dymaxion-approver-identity') ?? '';
      return new Response(Buffer.from('verified bytes'), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="evidence-bundle.zip"',
          ETag: '"abc"',
          'X-Unsafe-Upstream': 'must-not-pass',
        },
      });
    };
    try {
      const response = await GET(
        new Request(`http://admin/api/artifacts/${TOKEN}`, { headers: AUTH_HEADERS }),
        { params: Promise.resolve({ token: TOKEN }) },
      );
      assert.equal(response.status, 200);
      assert.equal(requestedUrl, `http://runtime.test:8787/api/artifacts/${TOKEN}`);
      assert.equal(suppliedIdentity, 'tailscale:operator@example.com');
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('content-type'), 'application/zip');
      assert.equal(
        response.headers.get('content-disposition'),
        'attachment; filename="evidence-bundle.zip"',
      );
      assert.equal(response.headers.get('x-unsafe-upstream'), null);
      assert.equal(await response.text(), 'verified bytes');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('artifact proxy maps runtime 404 and network failure without exposing details', async () => {
  await withProxyEnvironment(async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(null, { status: 404 });
      const unavailable = await GET(
        new Request(`http://admin/api/artifacts/${TOKEN}`, { headers: AUTH_HEADERS }),
        { params: Promise.resolve({ token: TOKEN }) },
      );
      assert.equal(unavailable.status, 404);
      assert.deepEqual(await unavailable.json(), { error: 'artifact unavailable' });

      globalThis.fetch = async () => { throw new Error('private upstream detail'); };
      const failed = await GET(
        new Request(`http://admin/api/artifacts/${TOKEN}`, { headers: AUTH_HEADERS }),
        { params: Promise.resolve({ token: TOKEN }) },
      );
      assert.equal(failed.status, 502);
      assert.deepEqual(await failed.json(), { error: 'artifact service unavailable' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
