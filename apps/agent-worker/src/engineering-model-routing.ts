import {
  createClaudeCodeTransport,
  createClaudeSubscriptionAuthPreflight,
} from "@remoteagent/model-provider-claude-code";
import {
  createCodexCliTransport,
  createCodexSubscriptionAuthPreflight,
} from "@remoteagent/model-provider-codex-cli";
import {
  assertSubscriptionModelInvocationRoute,
  ConfigurationError,
  createRoutedSubscriptionModelInvocationDescriptor,
  createRuntimeConfig,
  loadSubscriptionModelDeploymentConfig,
  resolveSubscriptionModelRoute,
  subscriptionAuthPreflightResult,
  subscriptionModelRole,
  type LoadedSubscriptionModelDeployment,
  type RuntimeConfig,
  type RuntimeTransport,
  type SubscriptionAuthPreflight,
  type SubscriptionModelInvocationDescriptorV1,
  type SubscriptionModelProfileV1,
  type SubscriptionModelProviderKind,
  type SubscriptionModelRole,
} from "@remoteagent/model-runtime";

export const ENGINEERING_MODEL_ENV = Object.freeze({
  configPath: "RA_ENGINEERING_MODEL_CONFIG_PATH",
});

type ReadySubscriptionTransport = RuntimeTransport & {
  assertInvocationReady(input: {
    invocation: SubscriptionModelInvocationDescriptorV1;
    signal?: AbortSignal;
  }): Promise<void>;
};

type TransportFactory = (input: {
  profile: SubscriptionModelProfileV1;
  preflight: SubscriptionAuthPreflight;
  environment: NodeJS.ProcessEnv;
}) => ReadySubscriptionTransport;

export type EngineeringModelRoleBinding = Readonly<{
  role: SubscriptionModelRole;
  transport: ReadySubscriptionTransport;
  config: RuntimeConfig;
  invocation: SubscriptionModelInvocationDescriptorV1;
  assertReadyForInvocation(input: {
    invocation: SubscriptionModelInvocationDescriptorV1;
    signal?: AbortSignal;
  }): Promise<void>;
}>;

export type ProductionEngineeringModelRouting = Readonly<{
  authority: "OFFICIAL_SUBSCRIPTION_CLI";
  deployment: LoadedSubscriptionModelDeployment;
  deploymentConfigDigest: string;
  roles: Readonly<Record<SubscriptionModelRole, EngineeringModelRoleBinding>>;
  forRole(role: SubscriptionModelRole): EngineeringModelRoleBinding;
}>;

export type ProductionEngineeringModelRoutingOptions = Readonly<{
  configPath: string;
  environment?: NodeJS.ProcessEnv;
  codexPreflight?: SubscriptionAuthPreflight;
  claudePreflight?: SubscriptionAuthPreflight;
  createCodexTransport?: TransportFactory;
  createClaudeTransport?: TransportFactory;
}>;

function runtimeConfig(profile: SubscriptionModelProfileV1): RuntimeConfig {
  return createRuntimeConfig({
    model: { provider: profile.provider, model_id: profile.model },
    timeoutMs: profile.timeout_ms,
    toolLimits: { maxIterations: 16, maxCalls: 64 },
  });
}

function preflightForProvider(input: {
  provider: SubscriptionModelProviderKind;
  codex: SubscriptionAuthPreflight;
  claude: SubscriptionAuthPreflight;
}): SubscriptionAuthPreflight {
  return input.provider === "codex_cli" ? input.codex : input.claude;
}

function exactAuthenticatedIdentity(input: {
  profile: SubscriptionModelProfileV1;
  result: unknown;
}): string {
  const result = subscriptionAuthPreflightResult.parse(input.result);
  if (result.status !== "SUBSCRIPTION_AUTHENTICATED") {
    throw new ConfigurationError(
      `Engineering subscription preflight refused with ${result.status}`,
    );
  }
  if (
    result.provider !== input.profile.provider ||
    result.profile_name !== input.profile.profile_name ||
    result.model !== input.profile.model
  ) {
    throw new ConfigurationError("Engineering subscription preflight identity mismatch");
  }
  return result.client_version;
}

/**
 * Authenticate and freeze the complete code-owned Engineering role registry.
 * Profile selection happens only through the deployment routes; preflight output
 * confirms identity and can never select a provider, model or role.
 */
export async function createProductionEngineeringModelRouting(
  options: ProductionEngineeringModelRoutingOptions,
): Promise<ProductionEngineeringModelRouting> {
  const environment = options.environment ?? process.env;
  const deployment = await loadSubscriptionModelDeploymentConfig(options.configPath);
  const codexPreflight =
    options.codexPreflight ?? createCodexSubscriptionAuthPreflight({ environment });
  const claudePreflight =
    options.claudePreflight ?? createClaudeSubscriptionAuthPreflight({ environment });
  const usedProfileNames = new Set(
    subscriptionModelRole.options.map((role) => deployment.config.routes[role]),
  );
  const clientVersions = new Map<string, string>();

  // Prove every used identity before constructing any transport. A later refusal
  // therefore cannot leave a partially usable provider registry.
  for (const profile of deployment.config.profiles) {
    if (!usedProfileNames.has(profile.profile_name)) continue;
    const preflight = preflightForProvider({
      provider: profile.provider,
      codex: codexPreflight,
      claude: claudePreflight,
    });
    clientVersions.set(
      profile.profile_name,
      exactAuthenticatedIdentity({
        profile,
        result: await preflight.verify({ profile }),
      }),
    );
  }

  const createCodex: TransportFactory =
    options.createCodexTransport ??
    ((input) =>
      createCodexCliTransport({
        profile: input.profile,
        preflight: input.preflight,
        environment: input.environment,
      }));
  const createClaude: TransportFactory =
    options.createClaudeTransport ??
    ((input) =>
      createClaudeCodeTransport({
        profile: input.profile,
        preflight: input.preflight,
        environment: input.environment,
      }));
  const transports = new Map<string, ReadySubscriptionTransport>();
  for (const profile of deployment.config.profiles) {
    if (!usedProfileNames.has(profile.profile_name)) continue;
    const preflight = preflightForProvider({
      provider: profile.provider,
      codex: codexPreflight,
      claude: claudePreflight,
    });
    transports.set(
      profile.profile_name,
      profile.provider === "codex_cli"
        ? createCodex({ profile, preflight, environment })
        : createClaude({ profile, preflight, environment }),
    );
  }

  const bind = (role: SubscriptionModelRole): EngineeringModelRoleBinding => {
    const route = resolveSubscriptionModelRoute(deployment, role);
    const clientVersion = clientVersions.get(route.profile.profile_name);
    const transport = transports.get(route.profile.profile_name);
    if (clientVersion === undefined || transport === undefined) {
      throw new ConfigurationError("Engineering role route was not authenticated");
    }
    const invocation = createRoutedSubscriptionModelInvocationDescriptor({
      deployment,
      role,
      clientVersion,
    });
    return Object.freeze({
      role,
      transport,
      config: runtimeConfig(route.profile),
      invocation,
      assertReadyForInvocation: async (input) => {
        const exact = assertSubscriptionModelInvocationRoute({
          deployment,
          role,
          invocation: input.invocation,
        });
        await transport.assertInvocationReady({
          invocation: exact,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      },
    });
  };
  const roles = Object.freeze({
    DESIGNER: bind("DESIGNER"),
    IMPLEMENTER: bind("IMPLEMENTER"),
    REVIEWER: bind("REVIEWER"),
    VERIFIER: bind("VERIFIER"),
  });
  return Object.freeze({
    authority: "OFFICIAL_SUBSCRIPTION_CLI" as const,
    deployment,
    deploymentConfigDigest: deployment.configDigest,
    roles,
    forRole: (role: SubscriptionModelRole) => roles[subscriptionModelRole.parse(role)],
  });
}

export async function engineeringModelRoutingFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<ProductionEngineeringModelRoutingOptions, "configPath" | "environment"> = {},
): Promise<ProductionEngineeringModelRouting | null> {
  const configPath = env[ENGINEERING_MODEL_ENV.configPath]?.trim();
  if (configPath === undefined || configPath === "") return null;
  return createProductionEngineeringModelRouting({
    ...options,
    configPath,
    environment: env,
  });
}
