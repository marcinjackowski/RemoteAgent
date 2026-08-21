/**
 * Data stack: PostgreSQL with PITR, S3 artifacts, KMS and Secrets (RA-025-WU-03).
 *
 * THE INVARIANT THIS STACK EXISTS TO PROTECT: PostgreSQL is the system of record
 * (ADR-0008 kept it that way even after AgentCore was rejected). `audit_log`,
 * `receipts` and `approvals` are append-only by database trigger, so a lost database is
 * not a lost database — it is lost EVIDENCE about external writes that already
 * happened. That reframes every choice below: point-in-time recovery is not a
 * convenience, it is the only way to answer "did we comment on that issue?" after a
 * failure.
 *
 * WHY A CUSTOMER-MANAGED KMS KEY rather than the AWS-managed default. Not compliance
 * theatre: the drill environment restores a snapshot of the dev database (AC4), and a
 * cross-account snapshot share is impossible with an AWS-managed key. So the key
 * choice is what makes the restore drill executable at all — an AWS-managed key would
 * have made AC4 undemonstrable and nobody would have noticed until the drill.
 *
 * WHY `RETAIN` AND NOT `SNAPSHOT` on removal. `SNAPSHOT` sounds safer and is worse: it
 * deletes the instance and leaves a snapshot, so a `cdk destroy` run against the wrong
 * environment still takes production offline while looking like it preserved
 * everything. `RETAIN` leaves the instance running and orphaned, which is loud,
 * recoverable and cheap to clean up deliberately.
 *
 * `drill` deliberately uses `DESTROY` — see `protectData` in `./config.ts`. A drill
 * environment that cannot be torn down is a drill nobody runs.
 */
import { CfnResource, Duration, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import type { ISecurityGroup, IVpc } from "aws-cdk-lib/aws-ec2";
import { InstanceClass, InstanceSize, InstanceType, SubnetType } from "aws-cdk-lib/aws-ec2";
import { Key } from "aws-cdk-lib/aws-kms";
import {
  Credentials,
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion,
  StorageType,
} from "aws-cdk-lib/aws-rds";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectOwnership,
  StorageClass,
} from "aws-cdk-lib/aws-s3";
import { Secret, type ISecret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

import {
  Component,
  resourceName,
  stackName,
  standardTags,
  type EnvironmentConfig,
} from "./config.js";

/**
 * The seven provider connections, as literal slugs.
 *
 * A closed tuple rather than a `string[]`: `ConnectionSlug` then has a literal type, so a
 * consumer selecting `"connection-discrd"` is a compile error rather than a
 * silently-empty filter.
 */
export const CONNECTION_SLUGS = [
  "jira",
  "gitlab",
  "gmail-private",
  "gmail-sondermind",
  "calendar-private",
  "calendar-sondermind",
  "discord",
] as const;

export type ConnectionSlug = (typeof CONNECTION_SLUGS)[number];

/** A connection credential, paired with the slug that identifies it at synth time. */
export interface ConnectionSecret {
  readonly slug: ConnectionSlug;
  readonly secret: Secret;
}

export interface DataStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: IVpc;
  readonly databaseSecurityGroup: ISecurityGroup;
}

export class DataStack extends Stack {
  public readonly database: DatabaseInstance;
  /**
   * The database's generated credential secret.
   *
   * Exposed as its own field because `secret` is declared on the concrete
   * `DatabaseInstance` and NOT on `IDatabaseInstance`, and it is `ISecret | undefined`.
   * Resolving it once here — where the generating call is visible — means the consuming
   * stacks take a required `ISecret` and cannot be constructed against a secretless
   * database at all.
   */
  public readonly databaseSecret: ISecret;
  public readonly artifactBucket: Bucket;
  public readonly encryptionKey: Key;
  /**
   * Credential secrets, one per provider connection. Never read by the model.
   *
   * Keyed by an explicit `slug` rather than relying on `secretName`: on a `Secret`
   * construct `secretName` is a CDK **token**, not the literal string, so
   * `secretName.endsWith("connection-discord")` is always false. That is not a
   * hypothetical — it made `ComputeStack` throw its own fail-closed error on the first
   * synth, which is the behaviour that surfaced the mistake instead of silently wiring
   * the wrong secret.
   */
  public readonly connectionSecrets: readonly ConnectionSecret[];

  public constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config, vpc, databaseSecurityGroup } = props;
    const removalPolicy = config.protectData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.encryptionKey = new Key(this, "Key", {
      alias: resourceName(config, Component.DATA, "key"),
      description: "RemoteAgent data at rest: database, artifacts, secrets",
      // Rotation is on. A long-lived key protecting append-only evidence is exactly
      // the case where rotation matters, because the data outlives every other
      // component.
      enableKeyRotation: true,
      removalPolicy,
    });

    this.artifactBucket = new Bucket(this, "Artifacts", {
      bucketName: resourceName(config, Component.DATA, "artifacts"),
      encryption: BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      // Artifacts are test logs, diffs and review evidence: the owner reads them, and
      // the threat model rates the boundary EXFILTRATION. Public access is blocked at
      // the bucket level rather than relying on object ACLs.
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      // Versioning is what makes an accidental overwrite recoverable. Evidence that
      // can be silently replaced is not evidence.
      versioned: true,
      removalPolicy,
      ...(config.protectData ? {} : { autoDeleteObjects: true }),
      lifecycleRules: [
        {
          id: "warm-then-cold",
          enabled: true,
          transitions: [
            {
              storageClass: StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(config.artifactWarmDays),
            },
          ],
          expiration: Duration.days(config.artifactRetentionDays),
          // Old versions go sooner than current ones: they exist to recover from an
          // overwrite, which is noticed in days, not months.
          noncurrentVersionExpiration: Duration.days(30),
        },
      ],
    });

    this.database = new DatabaseInstance(this, "Postgres", {
      instanceIdentifier: resourceName(config, Component.DATA, "postgres"),
      engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_17 }),
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MEDIUM),
      vpc,
      // ISOLATED, not PRIVATE_WITH_EGRESS: the database has no legitimate reason to
      // initiate an outbound connection, so it gets no route to one.
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
      multiAz: config.name === "prod",
      allocatedStorage: 50,
      maxAllocatedStorage: 500,
      storageType: StorageType.GP3,
      // Both stated, though `storageEncrypted` is redundant: CDK forces it to `true`
      // whenever `storageEncryptionKey` is set. Probed, because a mutation setting it to
      // `false` survived the policy check and I needed to know whether the check was weak
      // or the mutation unreachable — the synthesised template still said
      // `StorageEncrypted: true`, so it was the latter. Kept explicit anyway: a future
      // change removing the key would otherwise silently remove encryption too.
      storageEncrypted: true,
      storageEncryptionKey: this.encryptionKey,
      // AC4's foundation. `backupRetention` > 0 is what enables PITR at all; the
      // window length is per environment.
      backupRetention: Duration.days(config.pitrRetentionDays),
      deleteAutomatedBackups: !config.protectData,
      deletionProtection: config.protectData,
      removalPolicy,
      // Credentials are generated by Secrets Manager and never appear in the template.
      // A hardcoded password in a synthesised template is the classic IaC leak, and it
      // would be committed to git as part of `cdk.out` if anyone checked that in.
      credentials: Credentials.fromGeneratedSecret("ra_app", {
        secretName: resourceName(config, Component.DATA, "postgres-credentials"),
        encryptionKey: this.encryptionKey,
      }),
      // Postgres logs go to CloudWatch so an incident query does not require database
      // access — which may be exactly what is broken.
      cloudwatchLogsExports: ["postgresql"],
      // Minor versions auto-apply; major ones never do. A major upgrade can change
      // planner behaviour and trigger semantics, and this schema depends on both
      // (`ra_deny_mutation`, the `032` retention exception).
      autoMinorVersionUpgrade: true,
      // Deterministic maintenance windows: an unset window is chosen by AWS and can
      // differ between synths of the same template.
      preferredBackupWindow: "02:00-03:00",
      preferredMaintenanceWindow: "Sun:03:30-Sun:04:30",
    });

    // Resolved once, where the generating call above is visible. `secret` is
    // `ISecret | undefined` on the concrete class, so this is the single place the
    // absence has to be considered — and it is a synth-time failure rather than a
    // stack whose tasks silently cannot connect.
    const databaseSecret = this.database.secret;
    if (databaseSecret === undefined) {
      throw new Error(
        "DataStack: the database has no generated secret, so no component can be wired",
      );
    }
    this.databaseSecret = databaseSecret;

    // The generated credential secret defaults to `DeletionPolicy: Delete` even when the
    // instance itself is `Retain` — found by this task's own policy check, not by reading
    // the code. That combination is the worst of both: a `cdk destroy` leaves the database
    // running (good) with its only credential deleted (useless), so the retained data is
    // unreachable without a password reset through the RDS API.
    //
    // Applied via the L1 escape hatch because `Credentials.fromGeneratedSecret` exposes
    // no removal policy of its own.
    if (config.protectData) {
      const generated = this.database.node.findChild("Secret").node.defaultChild as CfnResource;
      generated.applyRemovalPolicy(RemovalPolicy.RETAIN);
    }

    // One secret per provider connection. Separate secrets rather than one JSON blob:
    // IAM can then grant a component access to exactly the connections it needs, which
    // is what makes the least-privilege register's `secretsmanager:GetSecretValue` row
    // narrow rather than nominal.
    this.connectionSecrets = CONNECTION_SLUGS.map((slug) => ({
      slug,
      secret: new Secret(
        this,
        `Secret${slug.replace(/(^|-)([a-z])/g, (_m, _s, c: string) => c.toUpperCase())}`,
        {
          secretName: resourceName(config, Component.DATA, `connection-${slug}`),
          description: `OAuth or API credential for the ${slug} connection`,
          encryptionKey: this.encryptionKey,
          removalPolicy,
        },
      ),
    }));

    for (const [key, value] of Object.entries(standardTags(config, Component.DATA))) {
      Tags.of(this).add(key, value);
    }
  }

  public static idFor(config: EnvironmentConfig): string {
    return stackName(config, Component.DATA);
  }
}
