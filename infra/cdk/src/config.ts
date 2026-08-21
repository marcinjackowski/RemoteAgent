/**
 * Environment configuration and naming (RA-025-WU-01).
 *
 * EVERYTHING THAT COULD VARY AT SYNTH TIME LIVES HERE, and that is what makes AC1
 * ("synth/diff is deterministic") achievable rather than aspirational. A CDK app that
 * reads `process.env`, calls `Date.now()` or resolves an SSM parameter during synth
 * produces a different template on different days — so a `cdk diff` showing changes no
 * human made becomes normal, and a real change hides in the noise.
 *
 * So: no clock, no randomness, no network, no environment variables. An environment is
 * a plain frozen literal, and the account and region are explicit. `env` is stated on
 * every stack for the same reason — an environment-agnostic stack synthesises
 * `Fn::GetAZs` pseudo-parameters instead of concrete AZs, which defeats a byte
 * comparison and also hides which AZs production actually uses.
 *
 * PROMOTION BOUNDARIES ARE EXPLICIT. `dev` and `prod` are separate accounts, not
 * separate prefixes in one account. A prefix is a naming convention, and a naming
 * convention has never stopped anyone typing the wrong `--profile`. The account id is
 * the boundary; the prefix only makes resources readable.
 */

/** Deployment environments. Closed set: a fourth needs an ADR, not a string. */
export const EnvironmentName = {
  /** The owner's development account. */
  DEV: "dev",
  /** A throwaway account used only by the restore drill (AC4). */
  DRILL: "drill",
  /** Production. Enabling deployment to it is a separate owner decision (AC in RA-026). */
  PROD: "prod",
} as const;

export type EnvironmentName = (typeof EnvironmentName)[keyof typeof EnvironmentName];

/** Everything a stack needs that varies between environments. */
export interface EnvironmentConfig {
  readonly name: EnvironmentName;
  /** Explicit, never resolved from the ambient CLI profile. */
  readonly account: string;
  readonly region: string;
  /**
   * Whether this environment may be deployed to without a fresh owner decision.
   *
   * `prod` is `false`, and the assertion that enforces it lives in `WU-07`'s policy
   * checks rather than only here — RA-026 AC6 keeps production enablement a separate
   * explicit decision, so a config flag alone would be too easy to flip.
   */
  readonly deployable: boolean;
  /** Database retention window for PITR, in days. */
  readonly pitrRetentionDays: number;
  /** How long raw event payloads are kept before the retention job may purge them. */
  readonly rawPayloadRetentionDays: number;
  /** Artifact retention before transition to infrequent access. */
  readonly artifactWarmDays: number;
  /** Artifact retention before deletion. */
  readonly artifactRetentionDays: number;
  /** Desired count for the worker service. */
  readonly workerCount: number;
  /**
   * ACM certificate ARN for the webhook listener.
   *
   * A required input rather than a certificate created here: DNS validation needs a hosted
   * zone this app does not own, and creating one during synth would make synth depend on
   * DNS state — breaking AC1. A placeholder the owner substitutes is a reviewable change;
   * an ambient lookup is not.
   *
   * There is deliberately no way to omit it and fall back to HTTP: `aws-cdk-lib` refuses
   * to synthesise an HTTPS listener with no certificate, and that refusal is welcome — a
   * webhook delivered over plain HTTP has already leaked its signature header.
   */
  readonly certificateArn: string;
  /** Monthly budget ceiling in USD, for the cost alarm. */
  readonly monthlyBudgetUsd: number;
  /**
   * Whether deletion protection and `RETAIN` removal policies apply.
   *
   * `false` in `drill` **on purpose**: a drill environment that could not be torn down
   * would make the drill expensive enough that nobody runs it, and an unrun drill is
   * the failure AC4 exists to prevent. `dev` keeps protection because it holds the
   * owner's real Jira and Gmail connections.
   */
  readonly protectData: boolean;
}

/**
 * The three environments.
 *
 * Account ids are placeholders and are deliberately NOT read from the environment: a
 * synth whose output depends on who is running it cannot be diffed. The owner
 * substitutes real ids in this file, as a reviewable change.
 */
export const ENVIRONMENTS: Readonly<Record<EnvironmentName, EnvironmentConfig>> = Object.freeze({
  [EnvironmentName.DEV]: Object.freeze({
    name: EnvironmentName.DEV,
    account: "000000000001",
    region: "eu-central-1",
    certificateArn:
      "arn:aws:acm:eu-central-1:000000000001:certificate/00000000-0000-0000-0000-000000000000",
    deployable: true,
    pitrRetentionDays: 7,
    rawPayloadRetentionDays: 30,
    artifactWarmDays: 30,
    artifactRetentionDays: 90,
    workerCount: 1,
    monthlyBudgetUsd: 200,
    protectData: true,
  }),
  [EnvironmentName.DRILL]: Object.freeze({
    name: EnvironmentName.DRILL,
    account: "000000000002",
    region: "eu-central-1",
    certificateArn:
      "arn:aws:acm:eu-central-1:000000000002:certificate/00000000-0000-0000-0000-000000000000",
    deployable: true,
    pitrRetentionDays: 1,
    rawPayloadRetentionDays: 7,
    artifactWarmDays: 7,
    artifactRetentionDays: 14,
    workerCount: 1,
    monthlyBudgetUsd: 50,
    protectData: false,
  }),
  [EnvironmentName.PROD]: Object.freeze({
    name: EnvironmentName.PROD,
    account: "000000000003",
    region: "eu-central-1",
    certificateArn:
      "arn:aws:acm:eu-central-1:000000000003:certificate/00000000-0000-0000-0000-000000000000",
    // Production enablement remains a separate, explicit owner decision.
    deployable: false,
    pitrRetentionDays: 35,
    rawPayloadRetentionDays: 90,
    artifactWarmDays: 30,
    artifactRetentionDays: 365,
    workerCount: 2,
    monthlyBudgetUsd: 1_000,
    protectData: true,
  }),
});

/** Resolve an environment by name, refusing an unknown one. */
export function environment(name: string): EnvironmentConfig {
  if (!Object.hasOwn(ENVIRONMENTS, name)) {
    // Fail closed. A typo resolving to a default would deploy the wrong thing, and
    // "dev" is the tempting default — which is exactly what you do not want when the
    // typo happened while targeting prod.
    throw new Error(
      `unknown environment ${name}; known: ${Object.values(EnvironmentName).join(", ")}`,
    );
  }
  return ENVIRONMENTS[name as EnvironmentName];
}

/** The components a stack can belong to. Used for naming, tagging and IAM scoping. */
export const Component = {
  NETWORK: "network",
  DATA: "data",
  QUEUE: "queue",
  WORKER: "worker",
  DISCORD: "discord",
  EXECUTOR: "executor",
  INGRESS: "ingress",
  OBSERVABILITY: "observability",
} as const;

export type Component = (typeof Component)[keyof typeof Component];

/** Stable resource name: `ra-<env>-<component>-<suffix>`. */
export function resourceName(
  config: EnvironmentConfig,
  component: Component,
  suffix: string,
): string {
  return `ra-${config.name}-${component}-${suffix}`;
}

/** Stack id, which also becomes the CloudFormation stack name. */
export function stackName(config: EnvironmentConfig, component: Component): string {
  return `Ra-${config.name}-${component}`;
}

/**
 * Tags applied to every stack.
 *
 * `remoteagent:environment` is the one that matters operationally: a cost report or an
 * incident query that cannot separate dev from prod is useless. Deliberately NO
 * `deployedAt` or `version` tag — either would make synth non-deterministic, and the
 * release manifest (RA-026 AC5) is the right place for that information because it is
 * produced once per release rather than baked into every resource.
 */
export function standardTags(
  config: EnvironmentConfig,
  component: Component,
): Readonly<Record<string, string>> {
  return Object.freeze({
    "remoteagent:environment": config.name,
    "remoteagent:component": component,
    "remoteagent:managed-by": "cdk",
  });
}
