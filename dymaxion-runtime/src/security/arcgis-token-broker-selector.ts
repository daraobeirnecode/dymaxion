import type {
  ArcGisApprovedFeatureQueryBinding,
  ArcGisCredentialDescriptor,
  ArcGisTargetRegistry,
  ArcGisTokenBroker,
} from './arcgis-connections.js';

export const ARCGIS_TOKEN_BROKER_SELECTOR_ENV = 'DYMAXION_ARCGIS_TOKEN_BROKER';

const POSTGRES_SELECTOR = 'postgres';
const UNAVAILABLE_ERROR = 'no trusted ArcGIS token broker is configured';
const CONFIGURATION_ERROR = 'ArcGIS token broker configuration is invalid';
const DESCRIPTOR_ERROR = 'ArcGIS credential description failed';
const AUTHORIZATION_ERROR = 'ArcGIS authorization materialization failed';

type TargetRegistryResolver = () => ArcGisTargetRegistry;

export interface ArcGisTokenBrokerFactoryDependencies {
  readonly targetRegistryResolver: TargetRegistryResolver;
}

export type ArcGisTokenBrokerFactory = (
  dependencies: ArcGisTokenBrokerFactoryDependencies,
) => Promise<ArcGisTokenBroker> | ArcGisTokenBroker;

export interface SelectArcGisTokenBrokerOptions {
  readonly targetRegistryResolver?: TargetRegistryResolver;
  readonly brokerFactory?: ArcGisTokenBrokerFactory;
}

function configurationError(): Error {
  return new Error(CONFIGURATION_ERROR);
}

function descriptorError(): Error {
  return new Error(DESCRIPTOR_ERROR);
}

function authorizationError(): Error {
  return new Error(AUTHORIZATION_ERROR);
}

const unavailableBroker: ArcGisTokenBroker = Object.freeze({
  async describe(): Promise<ArcGisCredentialDescriptor> {
    throw new Error(UNAVAILABLE_ERROR);
  },
  async getAuthorization(): Promise<string> {
    throw new Error(UNAVAILABLE_ERROR);
  },
});

function missingTargetRegistryResolver(): ArcGisTargetRegistry {
  throw configurationError();
}

function defaultBrokerFactory(targetRegistryResolver: TargetRegistryResolver): ArcGisTokenBrokerFactory {
  return async (): Promise<ArcGisTokenBroker> => {
    const [dbClient, repositoryModule, brokerModule] = await Promise.all([
      import('../db/client.js'),
      import('./arcgis-token-repository.js'),
      import('./postgres-arcgis-token-broker.js'),
    ]);
    const repository = repositoryModule.createDrizzleArcGisCredentialRepository(dbClient.db);
    return new brokerModule.PostgresArcGisTokenBroker({
      repository,
      targetRegistry: targetRegistryResolver(),
    });
  };
}

class LazyArcGisTokenBroker implements ArcGisTokenBroker {
  private brokerPromise: Promise<ArcGisTokenBroker> | undefined;
  private readonly factory: ArcGisTokenBrokerFactory;
  private readonly targetRegistryResolver: TargetRegistryResolver;

  constructor(factory: ArcGisTokenBrokerFactory, targetRegistryResolver: TargetRegistryResolver) {
    this.factory = factory;
    this.targetRegistryResolver = targetRegistryResolver;
  }

  private broker(): Promise<ArcGisTokenBroker> {
    if (!this.brokerPromise) {
      this.brokerPromise = Promise.resolve().then(() => this.factory({
        targetRegistryResolver: this.targetRegistryResolver,
      }));
    }
    return this.brokerPromise;
  }

  async describe(credentialAlias: string): Promise<ArcGisCredentialDescriptor> {
    try {
      return await (await this.broker()).describe(credentialAlias);
    } catch {
      throw descriptorError();
    }
  }

  async getAuthorization(
    credentialAlias: string,
    targetSlug: string,
    approvedBinding: ArcGisApprovedFeatureQueryBinding,
  ): Promise<string> {
    try {
      return await (await this.broker()).getAuthorization(credentialAlias, targetSlug, approvedBinding);
    } catch {
      throw authorizationError();
    }
  }
}

export function validateArcGisTokenBrokerSelector(selector: string | undefined): void {
  if (selector === undefined || selector === POSTGRES_SELECTOR) {
    return;
  }
  throw configurationError();
}

export function selectArcGisTokenBroker(
  selector: string | undefined,
  options: SelectArcGisTokenBrokerOptions = {},
): ArcGisTokenBroker {
  validateArcGisTokenBrokerSelector(selector);
  if (selector === undefined) {
    return unavailableBroker;
  }

  const targetRegistryResolver = options.targetRegistryResolver ?? missingTargetRegistryResolver;
  const factory = options.brokerFactory ?? defaultBrokerFactory(targetRegistryResolver);
  return new LazyArcGisTokenBroker(factory, targetRegistryResolver);
}
