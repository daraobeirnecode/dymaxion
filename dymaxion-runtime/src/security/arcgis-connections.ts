import { z } from 'zod';
import type { CapabilityExecutionContext } from '../contracts/capability.js';
import { loadConfig } from '../config/loader.js';
import { validateFeatureLayerUrl } from '../capabilities/query-feature-service.js';
import { validatePortalUrl } from '../capabilities/arcgis-rest.js';

const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const CREDENTIAL_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{2,255}$/;
const PERMISSION = /^[a-z][a-z0-9:_-]{1,127}$/;
const MAX_AUTHORIZATION_CHARS = 8_192;

export const ArcGisPortalKindSchema = z.enum(['arcgis-online', 'arcgis-enterprise']);
export type ArcGisPortalKind = z.infer<typeof ArcGisPortalKindSchema>;

export const ArcGisTargetSchema = z
  .object({
    target_slug: z.string().regex(SLUG),
    portal_kind: ArcGisPortalKindSchema,
    portal_root: z.string().min(1).max(2_048),
    service_root: z.string().min(1).max(2_048),
    layer_url: z.string().min(1).max(2_048),
    allowed_credential_aliases: z.array(z.string().regex(SLUG)).min(1).max(32),
    allowed_operations: z.array(z.literal('query')).length(1),
  })
  .strict()
  .superRefine((target, context) => {
    const portalProblem = validatePortalUrl(target.portal_root);
    if (portalProblem) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['portal_root'], message: portalProblem });
    }
    const layerProblem = validateFeatureLayerUrl(target.layer_url);
    if (layerProblem) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['layer_url'], message: layerProblem });
    }
    const serviceRootRaw = target.service_root;
    if (/\.\.|%|\\/.test(serviceRootRaw)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['service_root'],
        message: 'service_root must not contain traversal, encoded, or backslash segments',
      });
    } else {
      try {
        const url = new URL(serviceRootRaw);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['service_root'],
            message: 'service_root must be a credential-free HTTPS root without query or fragment',
          });
        }
        if (url.pathname === '/' || url.pathname.endsWith('/') || url.pathname.includes('//')) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['service_root'],
            message: 'service_root must have a canonical non-root path without a trailing slash',
          });
        }
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['service_root'], message: 'service_root must be absolute' });
      }
    }
    try {
      const portal = new URL(target.portal_root);
      const serviceRoot = new URL(target.service_root);
      const layer = new URL(target.layer_url);
      if (target.portal_kind === 'arcgis-online') {
        if (!portal.hostname.endsWith('.maps.arcgis.com') || portal.pathname !== '/') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['portal_root'],
            message: 'ArcGIS Online portal_root must be an exact organization maps.arcgis.com origin',
          });
        }
        if (!/^services(?:[1-9]\d*)?\.arcgis\.com$/.test(serviceRoot.hostname)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['service_root'],
            message: 'ArcGIS Online service_root must use an exact servicesN.arcgis.com host',
          });
        }
      }
      const rootPath = serviceRoot.pathname.replace(/\/+$/, '');
      if (layer.origin !== serviceRoot.origin || !layer.pathname.startsWith(`${rootPath}/`)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['layer_url'],
          message: 'layer_url must be an exact descendant of the configured service_root',
        });
      }
    } catch {
      // Individual URL issues above are more precise.
    }
    if (new Set(target.allowed_credential_aliases).size !== target.allowed_credential_aliases.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowed_credential_aliases'],
        message: 'allowed_credential_aliases must be unique',
      });
    }
  });

export const ArcGisTargetsConfigSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    targets: z.array(ArcGisTargetSchema).max(1_000),
  })
  .strict();

export type ArcGisTarget = z.infer<typeof ArcGisTargetSchema>;

export interface ArcGisTargetRegistry {
  resolve(targetSlug: string): ArcGisTarget;
}

export class InMemoryArcGisTargetRegistry implements ArcGisTargetRegistry {
  private readonly targets = new Map<string, ArcGisTarget>();

  constructor(rawTargets: readonly unknown[]) {
    for (const raw of rawTargets) {
      const target = ArcGisTargetSchema.parse(raw);
      if (this.targets.has(target.target_slug)) {
        throw new Error(`duplicate ArcGIS target slug '${target.target_slug}'`);
      }
      this.targets.set(target.target_slug, Object.freeze({
        ...target,
        allowed_credential_aliases: Object.freeze([...target.allowed_credential_aliases]),
        allowed_operations: Object.freeze([...target.allowed_operations]),
      }) as ArcGisTarget);
    }
  }

  resolve(targetSlug: string): ArcGisTarget {
    const target = this.targets.get(targetSlug);
    if (!target) throw new Error(`unknown ArcGIS target '${targetSlug}'`);
    return target;
  }
}

export const ArcGisCredentialDescriptorSchema = z
  .object({
    credential_alias: z.string().regex(SLUG),
    credential_identity: z.string().regex(CREDENTIAL_IDENTITY),
    portal_kind: ArcGisPortalKindSchema,
    permissions: z.array(z.string().regex(PERMISSION)).max(64),
    expires_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export type ArcGisCredentialDescriptor = z.infer<typeof ArcGisCredentialDescriptorSchema>;

export interface ArcGisTokenBroker {
  describe(credentialAlias: string): Promise<ArcGisCredentialDescriptor>;
  getAuthorization(credentialAlias: string, targetSlug: string): Promise<string>;
}

export interface InMemoryArcGisTokenRegistration {
  descriptor: ArcGisCredentialDescriptor;
  /** Called only after approval consumption. Implementations may rotate or
   * refresh tokens, but must return header material without persisting it. */
  authorizationForTarget(targetSlug: string): string | Promise<string>;
}

export class InMemoryArcGisTokenBroker implements ArcGisTokenBroker {
  private readonly registrations = new Map<string, Readonly<InMemoryArcGisTokenRegistration>>();

  constructor(rawRegistrations: readonly InMemoryArcGisTokenRegistration[]) {
    for (const raw of rawRegistrations) {
      const descriptor = ArcGisCredentialDescriptorSchema.parse(raw.descriptor);
      if (this.registrations.has(descriptor.credential_alias)) {
        throw new Error(`duplicate ArcGIS credential alias '${descriptor.credential_alias}'`);
      }
      this.registrations.set(descriptor.credential_alias, Object.freeze({
        descriptor: Object.freeze({
          ...descriptor,
          permissions: Object.freeze([...descriptor.permissions]),
        }) as ArcGisCredentialDescriptor,
        authorizationForTarget: raw.authorizationForTarget,
      }));
    }
  }

  async describe(credentialAlias: string): Promise<ArcGisCredentialDescriptor> {
    const registration = this.registrations.get(credentialAlias);
    if (!registration) throw new Error(`unknown ArcGIS credential alias '${credentialAlias}'`);
    return registration.descriptor;
  }

  async getAuthorization(credentialAlias: string, targetSlug: string): Promise<string> {
    const registration = this.registrations.get(credentialAlias);
    if (!registration) throw new Error(`unknown ArcGIS credential alias '${credentialAlias}'`);
    return registration.authorizationForTarget(targetSlug);
  }
}

const unavailableBroker: ArcGisTokenBroker = {
  async describe() {
    throw new Error('no trusted ArcGIS token broker is configured');
  },
  async getAuthorization() {
    throw new Error('no trusted ArcGIS token broker is configured');
  },
};

let configuredRegistry: ArcGisTargetRegistry | undefined;
let configuredTokenBroker: ArcGisTokenBroker | undefined;

export function configureArcGisConnections(options: {
  registry?: ArcGisTargetRegistry;
  tokenBroker?: ArcGisTokenBroker;
}): void {
  if (options.registry) {
    if (configuredRegistry) throw new Error('trusted ArcGIS target registry is already configured');
    configuredRegistry = options.registry;
  }
  if (options.tokenBroker) {
    if (configuredTokenBroker) throw new Error('trusted ArcGIS token broker is already configured');
    configuredTokenBroker = options.tokenBroker;
  }
}

export function resolveArcGisTargetRegistry(context: CapabilityExecutionContext): ArcGisTargetRegistry {
  const injected = context.io?.arcgisTargetRegistry as ArcGisTargetRegistry | undefined;
  if (injected) return injected;
  if (!configuredRegistry) {
    const config = ArcGisTargetsConfigSchema.parse(loadConfig().arcgisTargets);
    configuredRegistry = new InMemoryArcGisTargetRegistry(config.targets);
  }
  return configuredRegistry;
}

export function resolveArcGisTokenBroker(context: CapabilityExecutionContext): ArcGisTokenBroker {
  return (
    (context.io?.arcgisTokenBroker as ArcGisTokenBroker | undefined)
    ?? configuredTokenBroker
    ?? unavailableBroker
  );
}

export interface ResolvedArcGisReadConnection {
  target: ArcGisTarget;
  credential: ArcGisCredentialDescriptor;
}

export async function resolveArcGisReadConnection(
  targetSlug: string,
  credentialAlias: string,
  context: CapabilityExecutionContext,
): Promise<ResolvedArcGisReadConnection> {
  const target = resolveArcGisTargetRegistry(context).resolve(targetSlug);
  if (!target.allowed_operations.includes('query')) {
    throw new Error('ArcGIS target does not allow query operations');
  }
  if (!target.allowed_credential_aliases.includes(credentialAlias)) {
    throw new Error('credential alias is not allowed for the ArcGIS target');
  }
  let described: ArcGisCredentialDescriptor;
  try {
    described = await resolveArcGisTokenBroker(context).describe(credentialAlias);
  } catch {
    throw new Error('ArcGIS credential description failed');
  }
  let credential: ArcGisCredentialDescriptor;
  try {
    credential = ArcGisCredentialDescriptorSchema.parse(described);
  } catch {
    throw new Error('ArcGIS credential description failed');
  }
  if (credential.credential_alias !== credentialAlias) {
    throw new Error('ArcGIS broker credential alias mismatch');
  }
  if (credential.portal_kind !== target.portal_kind) {
    throw new Error('ArcGIS broker portal kind mismatch');
  }
  if (!credential.permissions.includes('feature:query')) {
    throw new Error('ArcGIS credential lacks feature:query permission');
  }
  if (credential.expires_at !== null) {
    const now = (context.now ?? (() => new Date()))();
    if (new Date(credential.expires_at).getTime() <= now.getTime()) {
      throw new Error('ArcGIS credential descriptor is expired');
    }
  }
  return { target, credential };
}

export function validateBearerAuthorization(raw: string): string {
  if (raw.length > MAX_AUTHORIZATION_CHARS || /[\r\n\u0000]/.test(raw)) {
    throw new Error('ArcGIS broker returned invalid authorization material');
  }
  if (!/^Bearer [A-Za-z0-9+/=._~-]+$/.test(raw)) {
    throw new Error('ArcGIS broker returned invalid authorization material');
  }
  return raw;
}

export function resetArcGisTargetRegistryForTest(): void {
  configuredRegistry = undefined;
  configuredTokenBroker = undefined;
}
