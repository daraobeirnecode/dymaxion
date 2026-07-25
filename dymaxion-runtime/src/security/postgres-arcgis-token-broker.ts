import {
  ARCGIS_TOKEN_EXPIRY_MARGIN_MS,
  ArcGisApprovedFeatureQueryBindingSchema,
  ArcGisCredentialDescriptorSchema,
  ArcGisTargetSchema,
  arcGisTargetConfigDigest,
  validateBearerAuthorization,
  type ArcGisApprovedFeatureQueryBinding,
  type ArcGisCredentialDescriptor,
  type ArcGisTargetRegistry,
  type ArcGisTokenBroker,
} from './arcgis-connections.js';
import {
  parseArcGisCredentialMetadataRecord,
  parseArcGisCredentialSecretEnvelopeRecord,
} from './arcgis-token-records.js';
import type { ArcGisCredentialRepository } from './arcgis-token-repository.js';
import { decrypt } from './token-envelope.js';

const DESCRIPTOR_ERROR = 'ArcGIS credential description failed';
const AUTHORIZATION_ERROR = 'ArcGIS authorization materialization failed';

type DecryptEnvelope = (envelope: string) => string;
type Now = () => Date;

export interface PostgresArcGisTokenBrokerOptions {
  readonly repository: ArcGisCredentialRepository;
  readonly targetRegistry: ArcGisTargetRegistry;
  readonly decryptEnvelope?: DecryptEnvelope;
  readonly now?: Now;
}

function genericDescriptorError(): Error {
  return new Error(DESCRIPTOR_ERROR);
}

function genericAuthorizationError(): Error {
  return new Error(AUTHORIZATION_ERROR);
}

function expiresSafelyBeyondMargin(expiresAt: string, now: Date): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > now.getTime() + ARCGIS_TOKEN_EXPIRY_MARGIN_MS;
}

function freezeDescriptor(descriptor: ArcGisCredentialDescriptor): ArcGisCredentialDescriptor {
  return Object.freeze({
    ...descriptor,
    permissions: Object.freeze([...descriptor.permissions]),
  }) as ArcGisCredentialDescriptor;
}

function isExactFeatureQueryPermission(permissions: readonly string[]): boolean {
  return permissions.length === 1 && permissions[0] === 'feature:query';
}

export class PostgresArcGisTokenBroker implements ArcGisTokenBroker {
  private readonly repository: ArcGisCredentialRepository;
  private readonly targetRegistry: ArcGisTargetRegistry;
  private readonly decryptEnvelope: DecryptEnvelope;
  private readonly now: Now;

  constructor(options: PostgresArcGisTokenBrokerOptions) {
    this.repository = options.repository;
    this.targetRegistry = options.targetRegistry;
    this.decryptEnvelope = options.decryptEnvelope ?? decrypt;
    this.now = options.now ?? (() => new Date());
  }

  async describe(credentialAlias: string): Promise<ArcGisCredentialDescriptor> {
    try {
      const metadata = await this.repository.findMetadata(credentialAlias);
      if (metadata === null) {
        throw genericDescriptorError();
      }
      const parsed = parseArcGisCredentialMetadataRecord(metadata);
      const descriptor = ArcGisCredentialDescriptorSchema.parse({
        credential_alias: parsed.credential_alias,
        credential_identity: parsed.credential_identity,
        portal_kind: parsed.portal_kind,
        permissions: parsed.permissions,
        expires_at: parsed.expires_at,
      });
      if (!expiresSafelyBeyondMargin(descriptor.expires_at ?? '', this.now())) {
        throw genericDescriptorError();
      }
      return freezeDescriptor(descriptor);
    } catch {
      throw genericDescriptorError();
    }
  }

  async getAuthorization(
    credentialAlias: string,
    targetSlug: string,
    approvedBinding: ArcGisApprovedFeatureQueryBinding,
  ): Promise<string> {
    try {
      const binding = ArcGisApprovedFeatureQueryBindingSchema.parse(approvedBinding);
      const target = ArcGisTargetSchema.parse(this.targetRegistry.resolve(targetSlug));
      if (target.target_slug !== targetSlug) {
        throw genericAuthorizationError();
      }
      if (!target.allowed_operations.includes('query')) {
        throw genericAuthorizationError();
      }
      if (!target.allowed_credential_aliases.includes(credentialAlias)) {
        throw genericAuthorizationError();
      }
      if (target.portal_kind !== binding.portal_kind) {
        throw genericAuthorizationError();
      }
      if (arcGisTargetConfigDigest(target) !== binding.target_config_sha256) {
        throw genericAuthorizationError();
      }

      const secretEnvelope = await this.repository.findSecretEnvelope(
        credentialAlias,
        binding.credential_identity,
      );
      if (secretEnvelope === null) {
        throw genericAuthorizationError();
      }
      const secret = parseArcGisCredentialSecretEnvelopeRecord(secretEnvelope);
      if (secret.credential_alias !== credentialAlias) {
        throw genericAuthorizationError();
      }
      if (secret.credential_identity !== binding.credential_identity) {
        throw genericAuthorizationError();
      }
      if (secret.portal_kind !== binding.portal_kind || secret.portal_kind !== target.portal_kind) {
        throw genericAuthorizationError();
      }
      if (!isExactFeatureQueryPermission(secret.permissions) || binding.permission !== 'feature:query') {
        throw genericAuthorizationError();
      }
      if (secret.token_type !== 'Bearer') {
        throw genericAuthorizationError();
      }
      if (!expiresSafelyBeyondMargin(secret.expires_at, this.now())) {
        throw genericAuthorizationError();
      }

      const token = this.decryptEnvelope(secret.encrypted_access_token_envelope);
      return validateBearerAuthorization(`Bearer ${token}`);
    } catch {
      throw genericAuthorizationError();
    }
  }
}
