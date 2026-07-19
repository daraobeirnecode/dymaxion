// Trusted execution identities are operator configuration, never model output.
// Destructive steps fail closed unless their exact skill slug is mapped to the
// concrete account/principal that the runtime will use for dispatch.

export function resolveExecutionCredentialIdentity(skill: string): string {
  const raw = process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON;
  if (!raw) {
    throw new Error(
      `no trusted execution identity configured for destructive skill '${skill}' (DYMAXION_CREDENTIAL_IDENTITIES_JSON)`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DYMAXION_CREDENTIAL_IDENTITIES_JSON must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DYMAXION_CREDENTIAL_IDENTITIES_JSON must be a JSON object keyed by skill slug');
  }
  const identity = (parsed as Record<string, unknown>)[skill];
  if (typeof identity !== 'string' || !identity.trim()) {
    throw new Error(`no trusted execution identity configured for destructive skill '${skill}'`);
  }
  return identity.trim();
}
