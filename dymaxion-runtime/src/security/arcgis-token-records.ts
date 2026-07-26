import { z } from 'zod';

const LOGICAL_ALIAS = /^[a-z][a-z0-9-]{0,63}$/;
const LOGICAL_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{2,255}$/;
const ENCRYPTED_ENVELOPE = /^[A-Za-z0-9+/=]{16,64}\.[A-Za-z0-9+/=]{16,64}\.[A-Za-z0-9+/=]{16,8064}$/;
const MAX_ENCRYPTED_ENVELOPE_CHARS = 8_192;

export const ArcGisCredentialPortalKindSchema = z.enum(['arcgis-online', 'arcgis-enterprise']);
export type ArcGisCredentialPortalKind = z.infer<typeof ArcGisCredentialPortalKindSchema>;

export const ARC_GIS_CREDENTIAL_PERMISSION = 'feature:query' as const;
export type ArcGisCredentialPermission = typeof ARC_GIS_CREDENTIAL_PERMISSION;

const OffsetIsoDateTimeSchema = z.string().datetime({ offset: true, precision: 3 });
const CredentialAliasSchema = z.string().regex(LOGICAL_ALIAS);
const CredentialIdentitySchema = z.string().regex(LOGICAL_IDENTITY);
const BearerTokenTypeSchema = z.literal('Bearer');
const PermissionsSchema = z
  .array(z.literal(ARC_GIS_CREDENTIAL_PERMISSION))
  .min(1)
  .max(64)
  .superRefine((permissions, context) => {
    if (new Set(permissions).size !== permissions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'ArcGIS credential permissions must be unique',
      });
    }
  });
const EncryptedAccessTokenEnvelopeSchema = z
  .string()
  .min(48)
  .max(MAX_ENCRYPTED_ENVELOPE_CHARS)
  .regex(ENCRYPTED_ENVELOPE);
const OperatorIdentitySchema = z.string().min(1).max(256).regex(/^[^\r\n\u0000]+$/);

const ArcGisCredentialBindingFieldsSchema = z.object({
  credential_alias: CredentialAliasSchema,
  credential_identity: CredentialIdentitySchema,
  portal_kind: ArcGisCredentialPortalKindSchema,
  permissions: PermissionsSchema,
  token_type: BearerTokenTypeSchema,
  expires_at: OffsetIsoDateTimeSchema,
});

const RawArcGisCredentialMetadataRecordSchema = ArcGisCredentialBindingFieldsSchema.extend({
  connected_at: OffsetIsoDateTimeSchema,
  refreshed_at: OffsetIsoDateTimeSchema,
  connected_by_user: OperatorIdentitySchema,
})
  .strict()
  .superRefine((record, context) => {
    if (Date.parse(record.expires_at) <= Date.parse(record.connected_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expires_at'],
        message: 'expires_at must be after connected_at',
      });
    }
    if (Date.parse(record.refreshed_at) < Date.parse(record.connected_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['refreshed_at'],
        message: 'refreshed_at must not be before connected_at',
      });
    }
  });

const RawArcGisCredentialSecretEnvelopeRecordSchema = ArcGisCredentialBindingFieldsSchema.extend({
  encrypted_access_token_envelope: EncryptedAccessTokenEnvelopeSchema,
}).strict();

export interface ArcGisCredentialMetadataRecord {
  readonly credential_alias: string;
  readonly credential_identity: string;
  readonly portal_kind: ArcGisCredentialPortalKind;
  readonly permissions: readonly ArcGisCredentialPermission[];
  readonly token_type: 'Bearer';
  readonly expires_at: string;
  readonly connected_at: string;
  readonly refreshed_at: string;
  readonly connected_by_user: string;
}

export interface ArcGisCredentialSecretEnvelopeRecord {
  readonly credential_alias: string;
  readonly credential_identity: string;
  readonly portal_kind: ArcGisCredentialPortalKind;
  readonly permissions: readonly ArcGisCredentialPermission[];
  readonly encrypted_access_token_envelope: string;
  readonly token_type: 'Bearer';
  readonly expires_at: string;
}

type RawArcGisCredentialMetadataRecord = z.infer<typeof RawArcGisCredentialMetadataRecordSchema>;
type RawArcGisCredentialSecretEnvelopeRecord = z.infer<typeof RawArcGisCredentialSecretEnvelopeRecordSchema>;

function freezePermissions(
  permissions: readonly ArcGisCredentialPermission[],
): readonly ArcGisCredentialPermission[] {
  return Object.freeze([...permissions]);
}

function freezeMetadataRecord(
  record: RawArcGisCredentialMetadataRecord,
): ArcGisCredentialMetadataRecord {
  return Object.freeze({
    credential_alias: record.credential_alias,
    credential_identity: record.credential_identity,
    portal_kind: record.portal_kind,
    permissions: freezePermissions(record.permissions),
    token_type: record.token_type,
    expires_at: record.expires_at,
    connected_at: record.connected_at,
    refreshed_at: record.refreshed_at,
    connected_by_user: record.connected_by_user,
  });
}

function freezeSecretEnvelopeRecord(
  record: RawArcGisCredentialSecretEnvelopeRecord,
): ArcGisCredentialSecretEnvelopeRecord {
  return Object.freeze({
    credential_alias: record.credential_alias,
    credential_identity: record.credential_identity,
    portal_kind: record.portal_kind,
    permissions: freezePermissions(record.permissions),
    encrypted_access_token_envelope: record.encrypted_access_token_envelope,
    token_type: record.token_type,
    expires_at: record.expires_at,
  });
}

export const ArcGisCredentialMetadataRecordSchema = RawArcGisCredentialMetadataRecordSchema
  .transform(freezeMetadataRecord);
export const ArcGisCredentialSecretEnvelopeRecordSchema = RawArcGisCredentialSecretEnvelopeRecordSchema
  .transform(freezeSecretEnvelopeRecord);

export function parseArcGisCredentialMetadataRecord(raw: unknown): ArcGisCredentialMetadataRecord {
  return ArcGisCredentialMetadataRecordSchema.parse(raw);
}

export function parseArcGisCredentialSecretEnvelopeRecord(raw: unknown): ArcGisCredentialSecretEnvelopeRecord {
  return ArcGisCredentialSecretEnvelopeRecordSchema.parse(raw);
}
