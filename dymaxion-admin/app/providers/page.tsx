import Link from 'next/link';
import { db, schema } from '@/drizzle/client';
import PostButton from '@/components/PostButton';
import { fmtDate } from '@/lib/format';
import { OAUTH_PROVIDERS } from '@/lib/oauth';

export const dynamic = 'force-dynamic';

const PROVIDER_META: Record<string, { title: string; models: string }> = {
  openai: { title: 'OpenAI', models: 'gpt-4o, gpt-4o-mini, gpt-4-turbo' },
  google: { title: 'Google Gemini', models: 'gemini-2.5-pro, gemini-2.5-flash' },
  azure: { title: 'Azure OpenAI (Entra ID)', models: 'gpt-4o-azure' },
  cohere: { title: 'Cohere', models: 'command-r-plus, command-r' },
};

export default async function ProvidersPage() {
  const tokens = await db.select().from(schema.oauthTokens);
  const byProvider = new Map(tokens.map((t) => [t.provider, t]));
  const anthropicSet = Boolean(process.env.ANTHROPIC_API_KEY);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-neutral-100">LLM providers</h1>
      <p className="text-xs text-neutral-500">
        Anthropic authenticates by API key (no OAuth offered for API access). The four OAuth
        providers connect here; tokens are stored AES-256-GCM encrypted in
        dymaxion.oauth_tokens and auto-refreshed by the runtime.
      </p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-100">Anthropic</h2>
            <span className={anthropicSet ? 'badge-ok' : 'badge-failed'}>
              {anthropicSet ? 'API key set' : 'API key unset'}
            </span>
          </div>
          <p className="text-xs text-neutral-500">
            Auth: API key via ANTHROPIC_API_KEY env (SOPS-encrypted .env). Models: claude-opus-4-8,
            claude-sonnet-5, claude-haiku-4-5.
          </p>
          {!anthropicSet && (
            <p className="text-xs text-amber-400">
              Set ANTHROPIC_API_KEY in the runtime .env and restart the container.
            </p>
          )}
        </div>

        <div className="card space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-100">Ollama</h2>
            <span className="badge-ok">local</span>
          </div>
          <p className="text-xs text-neutral-500">
            Auth: none — local inference at{' '}
            <code className="font-mono">
              {process.env.OLLAMA_BASE_URL ?? 'http://host.docker.internal:11434'}
            </code>
            . Models: llama3.3:70b, qwen3:32b.
          </p>
        </div>

        {OAUTH_PROVIDERS.map((p) => {
          const meta = PROVIDER_META[p]!;
          const token = byProvider.get(p);
          return (
            <div key={p} className="card space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-neutral-100">{meta.title}</h2>
                {token ? (
                  <span className="badge-ok">connected</span>
                ) : (
                  <span className="badge-neutral">not connected</span>
                )}
              </div>
              <p className="text-xs text-neutral-500">
                Auth: OAuth 2.0 (PKCE). Models: {meta.models}.
              </p>
              {token ? (
                <div className="space-y-2">
                  <div className="font-mono text-xs text-neutral-400">
                    <div>connected_at {fmtDate(token.connectedAt)}</div>
                    <div>expires_at {token.expiresAt ? fmtDate(token.expiresAt) : 'no expiry recorded'}</div>
                    {token.refreshedAt && <div>refreshed_at {fmtDate(token.refreshedAt)}</div>}
                    {token.scope && <div>scope {token.scope}</div>}
                    <div>connected_by {token.connectedByUser}</div>
                  </div>
                  <PostButton
                    endpoint={`/api/oauth/${p}/disconnect`}
                    label="Disconnect"
                    variant="danger"
                    confirmText={`Disconnect ${meta.title}? The stored token is deleted and LLM calls to this provider will fail until reconnected.`}
                  />
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <a href={`/api/oauth/${p}`} className="btn">
                    Connect
                  </a>
                  <Link
                    href={`/providers/${p}/connect`}
                    className="text-xs text-neutral-500 hover:text-neutral-300"
                  >
                    How this works
                  </Link>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
