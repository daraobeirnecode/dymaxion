import { and, eq } from 'drizzle-orm';
import { arcgisCredentials } from '../db/schema.js';
import {
  type ArcGisCredentialMetadataRecord,
  type ArcGisCredentialSecretEnvelopeRecord,
  parseArcGisCredentialMetadataRecord,
  parseArcGisCredentialSecretEnvelopeRecord,
} from './arcgis-token-records.js';

export interface ArcGisCredentialRepository {
  findMetadata(alias: string): Promise<ArcGisCredentialMetadataRecord | null>;
  findSecretEnvelope(
    alias: string,
    expectedCredentialIdentity: string,
  ): Promise<ArcGisCredentialSecretEnvelopeRecord | null>;
}

type Projection = Record<string, unknown>;
type QueryResult = readonly Record<string, unknown>[] | Promise<readonly Record<string, unknown>[]>;

export interface ArcGisCredentialSelectDatabase {
  select(projection: Projection): {
    from(table: unknown): {
      where(condition: unknown): {
        limit(count: number): QueryResult;
      };
    };
  };
}

const METADATA_PROJECTION = Object.freeze({
  credential_alias: arcgisCredentials.credentialAlias,
  credential_identity: arcgisCredentials.credentialIdentity,
  portal_kind: arcgisCredentials.portalKind,
  permissions: arcgisCredentials.permissions,
  token_type: arcgisCredentials.tokenType,
  expires_at: arcgisCredentials.expiresAt,
  connected_at: arcgisCredentials.connectedAt,
  refreshed_at: arcgisCredentials.refreshedAt,
  connected_by_user: arcgisCredentials.connectedByUser,
});

const SECRET_ENVELOPE_PROJECTION = Object.freeze({
  credential_alias: arcgisCredentials.credentialAlias,
  credential_identity: arcgisCredentials.credentialIdentity,
  portal_kind: arcgisCredentials.portalKind,
  permissions: arcgisCredentials.permissions,
  encrypted_access_token_envelope: arcgisCredentials.encryptedAccessTokenEnvelope,
  token_type: arcgisCredentials.tokenType,
  expires_at: arcgisCredentials.expiresAt,
});

function normalizeDateValues(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

export function createDrizzleArcGisCredentialRepository(
  database: ArcGisCredentialSelectDatabase,
): ArcGisCredentialRepository {
  async function findFirstByAlias(projection: Projection, alias: string): Promise<Record<string, unknown> | null> {
    const rows = await database
      .select(projection)
      .from(arcgisCredentials)
      .where(eq(arcgisCredentials.credentialAlias, alias))
      .limit(1);

    return rows[0] ?? null;
  }

  async function findFirstSecretByBinding(
    alias: string,
    expectedCredentialIdentity: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await database
      .select(SECRET_ENVELOPE_PROJECTION)
      .from(arcgisCredentials)
      .where(and(
        eq(arcgisCredentials.credentialAlias, alias),
        eq(arcgisCredentials.credentialIdentity, expectedCredentialIdentity),
      ))
      .limit(1);

    return rows[0] ?? null;
  }

  return Object.freeze({
    async findMetadata(alias: string): Promise<ArcGisCredentialMetadataRecord | null> {
      const row = await findFirstByAlias(METADATA_PROJECTION, alias);
      if (row === null) {
        return null;
      }
      return parseArcGisCredentialMetadataRecord(normalizeDateValues(row));
    },

    async findSecretEnvelope(
      alias: string,
      expectedCredentialIdentity: string,
    ): Promise<ArcGisCredentialSecretEnvelopeRecord | null> {
      const row = await findFirstSecretByBinding(alias, expectedCredentialIdentity);
      if (row === null) {
        return null;
      }
      return parseArcGisCredentialSecretEnvelopeRecord(normalizeDateValues(row));
    },
  });
}
