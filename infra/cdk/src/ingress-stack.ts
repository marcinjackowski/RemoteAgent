/**
 * Webhook ingress on a scalable HTTP boundary (RA-025-WU-06).
 *
 * WHY THIS IS SEPARATE FROM THE WORKERS. A webhook is the only unauthenticated inbound
 * path into the system: Jira, GitLab and Google all POST to it, and anyone can POST to
 * it. Putting that endpoint on the worker tasks would mean the component that runs
 * repository code is also the component reachable from the internet.
 *
 * WHAT THE INGRESS IS ALLOWED TO DO — and it is deliberately almost nothing:
 *
 *  1. verify the signature (`connector-jira/src/webhook/verify.ts`);
 *  2. write the raw payload to `raw_events` (append-only);
 *  3. enqueue a wake-up on SQS.
 *
 * It performs no provider write, invokes no model and reads no credential other than the
 * webhook signing secret. So its IAM role is the narrowest in the system, and a full
 * compromise of the internet-facing component yields the ability to insert rows into an
 * append-only table — not to act.
 *
 * The 202-before-processing shape is also a correctness property, not just latency:
 * providers retry on non-2xx, and a slow synchronous handler turns one webhook into
 * several deliveries. Deduplication is enforced by `events_dedupe_unique`, so a retry is
 * a no-op — but only if we accept fast enough not to provoke it.
 *
 * READINESS, not liveness, is wired to the target group here — the opposite of the ECS
 * health check in `compute-stack.ts`, and deliberately so. A load balancer should stop
 * routing to an instance that cannot reach the database (it would fail the insert), while
 * ECS should NOT restart it. Two different questions, two different probes; conflating
 * them is the RA-024 finding.
 */
import { Duration, Stack, Tags, type StackProps } from "aws-cdk-lib";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import type { ISecurityGroup, IVpc } from "aws-cdk-lib/aws-ec2";
import { SubnetType } from "aws-cdk-lib/aws-ec2";
import { Repository } from "aws-cdk-lib/aws-ecr";
import {
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
  Secret as EcsSecret,
} from "aws-cdk-lib/aws-ecs";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerAction,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import type { IKey } from "aws-cdk-lib/aws-kms";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

import {
  Component,
  resourceName,
  stackName,
  standardTags,
  type EnvironmentConfig,
} from "./config.js";
import type { ConnectionSecret } from "./data-stack.js";

export interface IngressStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: IVpc;
  readonly workloadSecurityGroup: ISecurityGroup;
  /** Declared in `NetworkStack`; see the cycle note there. */
  readonly loadBalancerSecurityGroup: ISecurityGroup;
  /**
   * The database's generated credential secret.
   *
   * Passed explicitly rather than read off the instance: `secret` exists on the
   * concrete `DatabaseInstance` but NOT on `IDatabaseInstance`, so reading it here
   * would force this stack to depend on the concrete class and silently accept a
   * secretless instance. Requiring it makes "there is a credential" a type-level
   * fact instead of a runtime check.
   */
  readonly databaseSecret: ISecret;
  readonly encryptionKey: IKey;
  readonly eventQueue: IQueue;
  /** The webhook signing secrets: the ONLY secrets this component may read. */
  readonly webhookSecrets: readonly ConnectionSecret[];
  readonly imageTag: string;
}

export class IngressStack extends Stack {
  public readonly loadBalancer: ApplicationLoadBalancer;
  public readonly ingressRole: Role;
  public readonly service: FargateService;

  public constructor(scope: Construct, id: string, props: IngressStackProps) {
    super(scope, id, props);
    const {
      config,
      vpc,
      workloadSecurityGroup,
      loadBalancerSecurityGroup,
      databaseSecret,
      encryptionKey,
      eventQueue,
      webhookSecrets,
      imageTag,
    } = props;

    this.loadBalancer = new ApplicationLoadBalancer(this, "Alb", {
      loadBalancerName: resourceName(config, Component.INGRESS, "alb"),
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroup: loadBalancerSecurityGroup,
      // Drop invalid headers before they reach the handler. Cheap, and it removes a
      // class of parser-confusion attack from a component that parses untrusted input
      // for a living.
      dropInvalidHeaderFields: true,
    });

    this.ingressRole = new Role(this, "IngressTaskRole", {
      roleName: resourceName(config, Component.INGRESS, "task-role"),
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
      description:
        "Internet-facing. Verifies signatures, appends raw_events, enqueues. " +
        "No provider write, no Bedrock, no connection credential.",
    });
    // Role-side statements only, for the cross-stack cycle reason documented in
    // `compute-stack.ts`: the `grant*` helpers also mutate the resource policy, which
    // lives in another stack.
    this.ingressRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
        resources: [databaseSecret.secretArn, ...webhookSecrets.map((e) => e.secret.secretArn)],
      }),
    );
    this.ingressRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [encryptionKey.keyArn],
      }),
    );
    // SEND only. The ingress must not consume: a component reachable from the internet
    // that could claim jobs would be able to influence which work runs.
    this.ingressRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"],
        resources: [eventQueue.queueArn],
      }),
    );

    const cluster = new Cluster(this, "Cluster", {
      clusterName: resourceName(config, Component.INGRESS, "cluster"),
      vpc,
    });
    const logGroup = new LogGroup(this, "Logs", {
      logGroupName: `/remoteagent/${config.name}/ingress`,
      retention: config.name === "prod" ? RetentionDays.SIX_MONTHS : RetentionDays.ONE_MONTH,
      encryptionKey,
    });

    // Explicit execution role, for the cycle reason in `compute-stack.ts`.
    const executionRole = new Role(this, "ExecutionRole", {
      roleName: resourceName(config, Component.INGRESS, "execution-role"),
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Pulls the image, writes logs, reads the database secret for injection",
    });
    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
        resources: [databaseSecret.secretArn],
      }),
    );
    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [encryptionKey.keyArn],
      }),
    );
    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`${logGroup.logGroupArn}:*`],
      }),
    );

    const taskDefinition = new FargateTaskDefinition(this, "IngressTask", {
      family: resourceName(config, Component.INGRESS, "task"),
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole: this.ingressRole,
      executionRole,
    });
    taskDefinition.addContainer("app", {
      image: ContainerImage.fromEcrRepository(
        Repository.fromRepositoryName(
          this,
          "Repo",
          resourceName(config, Component.WORKER, "image"),
        ),
        imageTag,
      ),
      command: ["node", "dist/ingress.js"],
      portMappings: [{ containerPort: 8080 }],
      logging: LogDrivers.awsLogs({ streamPrefix: "ingress", logGroup }),
      environment: {
        RA_ENVIRONMENT: config.name,
        RA_COMPONENT: Component.INGRESS,
        RA_QUEUE_URL: eventQueue.queueUrl,
      },
      // Imported by ARN; see the note in `compute-stack.ts` on the cross-stack cycle.
      secrets: {
        RA_DATABASE_URL: EcsSecret.fromSecretsManager(
          Secret.fromSecretCompleteArn(this, "DbSecretRef", databaseSecret.secretArn),
        ),
      },
      healthCheck: {
        command: ["CMD-SHELL", "node dist/health.js --liveness || exit 1"],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
    });

    this.service = new FargateService(this, "IngressService", {
      serviceName: resourceName(config, Component.INGRESS, "service"),
      cluster,
      taskDefinition,
      // Two, so a deploy or a single task failure does not drop webhooks. Providers do
      // retry, but a dropped delivery means a delay measured in provider backoff, and
      // for Calendar it can mean a missed watch renewal.
      desiredCount: 2,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [workloadSecurityGroup],
      minHealthyPercent: 50,
      circuitBreaker: { rollback: true },
    });

    const targetGroup = new ApplicationTargetGroup(this, "IngressTargets", {
      targetGroupName: resourceName(config, Component.INGRESS, "tg").slice(0, 32),
      vpc,
      port: 8080,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      targets: [this.service],
      healthCheck: {
        // READINESS here, unlike the ECS check above. The load balancer should stop
        // routing to a task that cannot reach the database — it would fail the insert —
        // while ECS should NOT restart it. Two questions, two probes.
        path: "/readyz",
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      // Short deregistration: the handler returns 202 before processing, so there is
      // little in-flight work to drain.
      deregistrationDelay: Duration.seconds(15),
    });

    // HTTPS only, and the certificate is supplied per environment rather than created
    // here: a DNS-validated certificate requires a hosted zone this stack does not own,
    // and creating one during synth would make synth depend on DNS state.
    this.loadBalancer.addListener("Https", {
      port: 443,
      protocol: ApplicationProtocol.HTTPS,
      // The certificate comes from config, per environment. `aws-cdk-lib` refuses to
      // synthesise an HTTPS listener without one, and that refusal is welcome: it makes
      // "forgot the certificate, fell back to HTTP" unrepresentable.
      certificates: [Certificate.fromCertificateArn(this, "Certificate", config.certificateArn)],
      defaultAction: ListenerAction.forward([targetGroup]),
    });

    for (const [key, value] of Object.entries(standardTags(config, Component.INGRESS))) {
      Tags.of(this).add(key, value);
    }
  }

  public static idFor(config: EnvironmentConfig): string {
    return stackName(config, Component.INGRESS);
  }
}
