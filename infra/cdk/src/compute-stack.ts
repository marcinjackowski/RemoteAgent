/**
 * Compute: worker, Discord gateway, action executor (RA-025-WU-05, WU-07 IAM).
 *
 * THREE SERVICES, AND THE SPLIT IS THE SECURITY BOUNDARY. It would be simpler to run
 * one task that does everything, and that is precisely what must not happen:
 *
 *  - **worker** plans and codes. It needs Bedrock, the workspace, artifacts and the
 *    database. It must NOT be able to read a provider credential, because the code it
 *    runs comes from a repository and the text it reads comes from Jira — both
 *    `UNTRUSTED_DATA`.
 *  - **executor** performs external writes. It needs provider credentials and the
 *    database. It must NOT be able to invoke Bedrock, because it contains no model
 *    reasoning at all (`action-executor.ts`) — so a Bedrock permission on it could only
 *    ever be misuse.
 *  - **discord** talks to the owner. It needs the Discord credential and the database.
 *    Nothing else.
 *
 * That is AC2 ("IAM roles separated per component") expressed as three task roles with
 * disjoint grants, and it is enforced by test rather than by review: `test/infra`
 * asserts the worker role has no `secretsmanager:GetSecretValue` on connection secrets
 * and the executor role has no `bedrock:InvokeModel`.
 *
 * NO DOCKER IMAGE IS BUILT HERE. Docker is broken on this machine (`AGENTS.md`), so
 * `DockerImageAsset` would make `synth` fail and AC1 unverifiable. Images are referenced
 * by repository and tag instead, which is also the better deployment shape: a build and
 * a deploy are separate steps, and a synth that rebuilds an image is a synth whose
 * output depends on the local Docker cache.
 *
 * HEALTH CHECK USES LIVENESS, NOT READINESS. This is the RA-024 finding applied: ECS
 * restarts a task whose health check fails, and `liveness` deliberately does not depend
 * on PostgreSQL. Wiring readiness here would restart-loop every worker during a
 * database outage — exactly when their in-flight leases and logs are the only evidence
 * available.
 */
import { Duration, Stack, Tags, type StackProps } from "aws-cdk-lib";
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
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import type { IKey } from "aws-cdk-lib/aws-kms";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
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

/**
 * SQS consume permissions, enumerated.
 *
 * `queue.grantConsumeMessages(role)` would also touch the queue's resource policy in the
 * queue stack, producing the same cross-stack cycle as the secret and bucket grants.
 */
function grantQueueConsume(role: Role, queueArn: string): void {
  role.addToPolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:ChangeMessageVisibility",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
      ],
      resources: [queueArn],
    }),
  );
}
import type { ConnectionSecret } from "./data-stack.js";

export interface ComputeStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: IVpc;
  readonly workloadSecurityGroup: ISecurityGroup;
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
  readonly artifactBucket: IBucket;
  readonly encryptionKey: IKey;
  readonly connectionSecrets: readonly ConnectionSecret[];
  readonly eventQueue: IQueue;
  /** Image tag to run. Passed in so synth never inspects a local Docker daemon. */
  readonly imageTag: string;
}

export class ComputeStack extends Stack {
  public readonly cluster: Cluster;
  public readonly workerRole: Role;
  public readonly executorRole: Role;
  public readonly discordRole: Role;
  public readonly services: readonly FargateService[];

  public constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    const {
      config,
      vpc,
      workloadSecurityGroup,
      databaseSecret,
      artifactBucket,
      encryptionKey,
      connectionSecrets,
      eventQueue,
      imageTag,
    } = props;

    const repository = Repository.fromRepositoryName(
      this,
      "Repo",
      resourceName(config, Component.WORKER, "image"),
    );
    const image = ContainerImage.fromEcrRepository(repository, imageTag);

    this.cluster = new Cluster(this, "Cluster", {
      clusterName: resourceName(config, Component.WORKER, "cluster"),
      vpc,
      containerInsightsV2: undefined,
    });

    /** One role, one component. No shared role — that is the whole point of AC2. */
    const makeRole = (component: Component, description: string): Role => {
      const role = new Role(this, `${component}TaskRole`, {
        roleName: resourceName(config, component, "task-role"),
        assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
        description,
      });
      // Every component reads the database credential and the KMS key that wraps it.
      // Narrow: this is the ONE secret they share, and it is not a provider credential.
      //
      // Granted by adding a statement to the ROLE rather than by calling
      // `secret.grantRead(role)` / `key.grantDecrypt(role)`. Those helpers ALSO mutate
      // the resource-side policy, which lives in `DataStack` — so the data stack starts
      // depending on this stack's role ARN while this stack already depends on the data
      // stack's secret. CDK reports that as a `DependencyCycle` at synth, measured:
      // the first version used the helpers and synth refused.
      //
      // Role-side statements are sufficient here because both the secret and the key are
      // in the SAME account, where an identity policy alone authorises access. A
      // cross-account grant would genuinely need the resource policy, and would then
      // need the role ARN passed in rather than the construct.
      role.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
          resources: [databaseSecret.secretArn],
        }),
      );
      role.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["kms:Decrypt", "kms:DescribeKey"],
          resources: [encryptionKey.keyArn],
        }),
      );
      return role;
    };

    this.workerRole = makeRole(
      Component.WORKER,
      "Plans and codes. Bedrock + artifacts + database. NO provider credentials.",
    );
    this.executorRole = makeRole(
      Component.EXECUTOR,
      "Performs external writes. Provider credentials + database. NO Bedrock.",
    );
    this.discordRole = makeRole(
      Component.DISCORD,
      "Owner control channel. Discord credential + database only.",
    );

    // --- worker: Bedrock and artifacts, no provider credentials -----------------
    this.workerRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        // Enumerated, not `bedrock:*`. The least-privilege register lists exactly these
        // two actions, and RA-025 AC2 requires an ADR for any wildcard.
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        // Scoped to the foundation models in this region rather than `*`: an
        // account-wide Bedrock grant would let a compromised worker invoke any model,
        // including one with different data-handling terms.
        resources: [`arn:aws:bedrock:${config.region}::foundation-model/*`],
      }),
    );
    // Role-side, for the cycle reason above. Enumerated rather than `grantReadWrite`,
    // which silently includes `s3:DeleteObject` — a worker that can delete evidence is
    // not what "read write artifacts" is meant to mean, and the helper's name hides it.
    this.workerRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"],
        resources: [`${artifactBucket.bucketArn}/*`],
      }),
    );
    this.workerRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [artifactBucket.bucketArn],
      }),
    );
    grantQueueConsume(this.workerRole, eventQueue.queueArn);

    // --- executor: provider credentials, no Bedrock -----------------------------
    this.executorRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
        resources: connectionSecrets.map((entry) => entry.secret.secretArn),
      }),
    );
    grantQueueConsume(this.executorRole, eventQueue.queueArn);

    // --- discord: only its own credential ---------------------------------------
    // Matched on the explicit `slug`, NOT on `secretName`: on a `Secret` construct
    // `secretName` is a CDK token, so a string comparison against it is always false.
    // The first version of this did exactly that and tripped the guard below, which is
    // how the mistake surfaced rather than silently granting nothing.
    const discordSecret = connectionSecrets.find((entry) => entry.slug === "discord");
    if (discordSecret === undefined) {
      throw new Error("no discord connection secret; ComputeStack cannot wire the gateway");
    }
    this.discordRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
        resources: [discordSecret.secret.secretArn],
      }),
    );
    this.discordRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"],
        resources: [eventQueue.queueArn],
      }),
    );

    // ONE explicit execution role, created here.
    //
    // `EcsSecret.fromSecretsManager` grants the task's EXECUTION role read access to the
    // secret — and if the execution role is auto-created by the task definition, that
    // grant lands on the secret's resource policy in `DataStack`, reintroducing the same
    // cross-stack cycle the role-side grants above were written to avoid. Declaring the
    // role here and granting it role-side keeps the dependency one-directional.
    //
    // The execution role is deliberately SEPARATE from the three task roles and shared
    // between them: it pulls the image and writes logs, which is identical work for all
    // three, and it never runs application code. Merging it into the task roles would
    // hand every component ECR and log-group permissions it does not need.
    const executionRole = new Role(this, "ExecutionRole", {
      roleName: resourceName(config, Component.WORKER, "execution-role"),
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
        // `GetAuthorizationToken` is account-level by definition; the policy checks
        // allowlist it for exactly that reason.
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ],
        resources: [repository.repositoryArn],
      }),
    );

    const logGroup = new LogGroup(this, "Logs", {
      logGroupName: `/remoteagent/${config.name}`,
      // Logs are redacted at the export boundary (RA-024), so retention is about
      // incident forensics, not about limiting exposure.
      retention: config.name === "prod" ? RetentionDays.SIX_MONTHS : RetentionDays.ONE_MONTH,
      encryptionKey,
    });

    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`${logGroup.logGroupArn}:*`],
      }),
    );

    const makeService = (
      component: Component,
      role: Role,
      desiredCount: number,
      command: readonly string[],
    ): FargateService => {
      const taskDefinition = new FargateTaskDefinition(this, `${component}Task`, {
        family: resourceName(config, component, "task"),
        cpu: 512,
        memoryLimitMiB: 1024,
        taskRole: role,
        executionRole,
      });
      taskDefinition.addContainer("app", {
        image,
        command: [...command],
        logging: LogDrivers.awsLogs({ streamPrefix: component, logGroup }),
        environment: {
          RA_ENVIRONMENT: config.name,
          RA_COMPONENT: component,
          RA_QUEUE_URL: eventQueue.queueUrl,
          RA_ARTIFACT_BUCKET: artifactBucket.bucketName,
        },
        // The database credential arrives as a secret reference, so it never appears in
        // the task definition's plaintext environment — where it would be readable by
        // anyone with `ecs:DescribeTaskDefinition`.
        // Injected by ECS from Secrets Manager, referencing the secret by ARN.
        //
        // `EcsSecret.fromSecretsManager(databaseSecret)` grants the execution role on the
        // SECRET'S resource policy, which lives in `DataStack` — recreating the
        // cross-stack cycle even with an explicit execution role. Measured: role-side
        // grants and then an explicit execution role each MOVED the cycle rather than
        // removing it; importing the secret by ARN is the form that breaks it, because an
        // imported construct has no resource policy for CDK to mutate.
        //
        // The execution role's read permission is granted role-side above, so injection
        // still works. The value never appears in plaintext in the template.
        secrets: {
          RA_DATABASE_URL: EcsSecret.fromSecretsManager(
            Secret.fromSecretCompleteArn(this, `${component}DbSecretRef`, databaseSecret.secretArn),
          ),
        },
        healthCheck: {
          // LIVENESS, not readiness. See the module comment.
          command: ["CMD-SHELL", "node dist/health.js --liveness || exit 1"],
          interval: Duration.seconds(30),
          timeout: Duration.seconds(5),
          retries: 3,
          startPeriod: Duration.seconds(60),
        },
      });
      return new FargateService(this, `${component}Service`, {
        serviceName: resourceName(config, component, "service"),
        cluster: this.cluster,
        taskDefinition,
        desiredCount,
        vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [workloadSecurityGroup],
        // Draining time. `readiness` reports DEGRADED while a worker finishes held
        // leases, so this window is what lets it finish rather than abandon them.
        minHealthyPercent: 50,
        circuitBreaker: { rollback: true },
      });
    };

    this.services = [
      makeService(Component.WORKER, this.workerRole, config.workerCount, [
        "node",
        "dist/worker.js",
      ]),
      // ONE executor task, always. Not a scaling decision — a correctness one: the
      // executor performs external writes, and while the database's approval fencing
      // makes a second instance safe, a single writer keeps the "which process sent
      // this?" question answerable during an incident.
      makeService(Component.EXECUTOR, this.executorRole, 1, ["node", "dist/executor.js"]),
      // ONE Discord gateway. A second would open a second gateway session and receive
      // every interaction twice.
      makeService(Component.DISCORD, this.discordRole, 1, ["node", "dist/discord.js"]),
    ];

    for (const [key, value] of Object.entries(standardTags(config, Component.WORKER))) {
      Tags.of(this).add(key, value);
    }
  }

  public static idFor(config: EnvironmentConfig): string {
    return stackName(config, Component.WORKER);
  }
}
