import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isOAuthProvider, providerScopes } from '@/lib/oauth';

export const dynamic = 'force-dynamic';

const ENV_VARS: Record<string, string[]> = {
  openai: ['OPENAI_OAUTH_CLIENT_ID', 'OPENAI_OAUTH_CLIENT_SECRET'],
  google: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
  azure: ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'],
  cohere: ['COHERE_OAUTH_CLIENT_ID', 'COHERE_OAUTH_CLIENT_SECRET'],
};

export default async function ConnectExplainerPage({
  params,
}: {
  params: Promise<{ provider: string }>;
}) {
  const { provider } = await params;
  if (!isOAuthProvider(provider)) notFound();

  const envVars = ENV_VARS[provider]!;
  const missing = envVars.filter((v) => !process.env[v]);

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-lg font-semibold text-neutral-100">
        Connect {provider} via OAuth 2.0
      </h1>

      <div className="card space-y-3 text-sm text-neutral-300">
        <p>The flow, step by step:</p>
        <ol className="list-decimal space-y-1 pl-5 text-neutral-400">
          <li>
            The dashboard generates a PKCE code verifier and state, stores them in
            dymaxion.oauth_flow_state, and redirects your browser to the provider&apos;s
            authorization endpoint.
          </li>
          <li>You sign in at the provider and grant the requested scopes.</li>
          <li>
            The provider redirects back to{' '}
            <code className="font-mono text-xs">/api/oauth/{provider}/callback</code> on this host
            (Tailscale address — register it as an allowed redirect URI in the provider&apos;s app
            settings).
          </li>
          <li>
            The dashboard exchanges the code for tokens, encrypts them with AES-256-GCM
            (OAUTH_TOKEN_ENCRYPTION_KEY), and upserts dymaxion.oauth_tokens.
          </li>
          <li>The runtime decrypts in-memory per LLM call and auto-refreshes before expiry.</li>
        </ol>
        <p className="text-xs text-neutral-500">
          Requested scopes: <code className="font-mono">{providerScopes(provider)}</code>
        </p>
        <p className="text-xs text-neutral-500">
          Required env vars: <code className="font-mono">{envVars.join(', ')}</code>
        </p>
        {missing.length > 0 && (
          <p className="text-xs text-amber-400">
            Missing env vars: {missing.join(', ')} — set them in the SOPS-encrypted .env before
            starting the flow.
          </p>
        )}
      </div>

      <div className="flex items-center gap-4">
        <a href={`/api/oauth/${provider}`} className="btn">
          Start OAuth flow
        </a>
        <Link href="/providers" className="text-xs text-neutral-500 hover:text-neutral-300">
          Back to providers
        </Link>
      </div>
    </div>
  );
}
