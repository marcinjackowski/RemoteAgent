/**
 * The CDK app: five stacks per environment, wired explicitly (RA-025-WU-01..WU-06).
 *
 * DETERMINISM IS THE CONTRACT OF THIS FILE (AC1). Nothing here reads a clock, a random
 * source, an environment variable or the network. `buildApp` takes everything that could
 * vary as an argument, so the same inputs always produce the same template — which is
 * what makes `cdk diff` mean "someone changed something" rather than "time passed".
 *
 * `imageTag` is an argument for exactly that reason. It is the one genuinely varying
 * input, and making it explicit is what keeps the variation visible in a diff instead of
 * hidden in a `latest` tag that silently means something different every deploy.
 *
 * STACK ORDER IS DEPENDENCY ORDER, expressed by passing constructs rather than by
 * `addDependency`. A stack that receives another's VPC cannot be deployed first — the
 * dependency is a type error rather than a convention, which is the same reasoning as
 * the branded `Transaction` in `packages/database`.
 */
import { App, type Environment } from "aws-cdk-lib";

import { Component, stackName, type EnvironmentConfig } from "./config.js";
import { ComputeStack } from "./compute-stack.js";
import { DataStack } from "./data-stack.js";
import { IngressStack } from "./ingress-stack.js";
import { NetworkStack } from "./network-stack.js";
import { QueueStack } from "./queue-stack.js";

export interface BuildAppInput {
  readonly config: EnvironmentConfig;
  /**
   * Container image tag to run.
   *
   * Required, with no default. A `latest` default would make two synths of the same
   * commit describe different deployments, and it is the single most common way an IaC
   * "no changes" diff becomes a lie.
   */
  readonly imageTag: string;
}

export interface BuiltApp {
  readonly app: App;
  readonly network: NetworkStack;
  readonly data: DataStack;
  readonly queue: QueueStack;
  readonly compute: ComputeStack;
  readonly ingress: IngressStack;
}

export function buildApp(input: BuildAppInput): BuiltApp {
  const { config, imageTag } = input;
  // Explicit account and region on every stack. An environment-agnostic stack
  // synthesises `Fn::GetAZs` pseudo-parameters instead of concrete AZs, which defeats a
  // byte-for-byte diff and hides which AZs an environment actually uses.
  const env: Environment = { account: config.account, region: config.region };

  const app = new App();

  const network = new NetworkStack(app, stackName(config, Component.NETWORK), { config, env });

  const data = new DataStack(app, stackName(config, Component.DATA), {
    config,
    env,
    vpc: network.vpc,
    databaseSecurityGroup: network.databaseSecurityGroup,
  });

  const queue = new QueueStack(app, stackName(config, Component.QUEUE), {
    config,
    env,
    encryptionKey: data.encryptionKey,
  });

  const compute = new ComputeStack(app, stackName(config, Component.WORKER), {
    config,
    env,
    vpc: network.vpc,
    workloadSecurityGroup: network.workloadSecurityGroup,
    databaseSecret: data.databaseSecret,
    artifactBucket: data.artifactBucket,
    encryptionKey: data.encryptionKey,
    connectionSecrets: data.connectionSecrets,
    eventQueue: queue.eventQueue,
    imageTag,
  });

  const ingress = new IngressStack(app, stackName(config, Component.INGRESS), {
    config,
    env,
    vpc: network.vpc,
    workloadSecurityGroup: network.workloadSecurityGroup,
    loadBalancerSecurityGroup: network.loadBalancerSecurityGroup,
    databaseSecret: data.databaseSecret,
    encryptionKey: data.encryptionKey,
    eventQueue: queue.eventQueue,
    // The ingress reads ONLY webhook signing secrets, never a connection credential.
    // Selected here rather than inside the stack so the narrowing is visible at the
    // wiring site, where a future change would notice it.
    // Filtered on the literal `slug`, so a typo is a compile error rather than an
    // empty list that silently grants the ingress nothing.
    webhookSecrets: data.connectionSecrets.filter(
      (entry) => entry.slug === "jira" || entry.slug === "gitlab",
    ),
    imageTag,
  });

  return { app, network, data, queue, compute, ingress };
}
