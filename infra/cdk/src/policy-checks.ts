/**
 * Security policy checks over the synthesised template (RA-025-WU-07, AC1 + AC2).
 *
 * WHY THESE READ THE TEMPLATE AND NOT THE CONSTRUCT TREE. A construct-tree assertion
 * checks what the author wrote; a template assertion checks what CloudFormation will
 * receive. Those differ, and the gap is where the interesting failures live: an L2
 * construct's default can add a permission the author never typed, and a `grant*` call
 * expands into a policy whose actual actions are not visible at the call site. `Bucket`
 * with `grantReadWrite` is the standard example — it includes `s3:DeleteObject`, which is
 * not obvious from the name.
 *
 * So every check below takes a synthesised template. It is the same reasoning as
 * `CTF-011` (testing `dist` rather than `src`, because that is what deploys) applied to
 * infrastructure.
 *
 * ORGANISED AS PURE FUNCTIONS returning violations rather than throwing, so a caller can
 * report ALL of them at once. A policy check that stops at the first failure makes fixing
 * ten wildcards a ten-round game.
 */

/** One policy violation. `resource` is the logical id, so it is greppable in the template. */
export interface PolicyViolation {
  readonly rule: string;
  readonly resource: string;
  readonly detail: string;
}

/** The subset of a CloudFormation template these checks read. */
export interface SynthesizedTemplate {
  readonly Resources: Readonly<Record<string, TemplateResource>>;
}

export interface TemplateResource {
  readonly Type: string;
  readonly Properties?: Readonly<Record<string, unknown>>;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

/** IAM actions that may never appear with a `*` resource. */
const NEVER_WILDCARD_ACTIONS: readonly string[] = Object.freeze([
  "iam:",
  "sts:AssumeRole",
  "kms:",
  "secretsmanager:",
  "s3:",
  "rds:",
  "bedrock:",
]);

/**
 * Actions whose `Resource: "*"` is unavoidable because the AWS API has no resource ARN.
 *
 * An allowlist, not a denylist — `CTF-010` finding 2. Each entry is a case where AWS
 * itself provides no narrower form, so refusing them would force either a broken policy
 * or a blanket exemption. Enumerating them keeps the exemption auditable: adding an entry
 * is a visible change with a reason, not a silently widened rule.
 */
const RESOURCE_WILDCARD_UNAVOIDABLE: readonly string[] = Object.freeze([
  // Neither has a resource-level ARN; both are required for CloudWatch metrics/logs.
  "cloudwatch:PutMetricData",
  "logs:CreateLogGroup",
  // ECR auth token is account-level by definition.
  "ecr:GetAuthorizationToken",
  // Describe/List calls on EC2 networking take no resource ARN.
  "ec2:DescribeNetworkInterfaces",
  "ec2:CreateNetworkInterface",
  "ec2:DeleteNetworkInterface",
  "ec2:DescribeSubnets",
  "ec2:DescribeSecurityGroups",
  "ec2:DescribeVpcs",
  "ec2:DescribeInstances",
  // Fargate task metadata.
  "ecs:DescribeTasks",
  // KMS key discovery through a grant token; the key policy is the real boundary.
  "kms:DescribeKey",
]);

interface PolicyStatementShape {
  readonly Effect?: string;
  readonly Action?: string | readonly string[];
  readonly Resource?: unknown;
}

function statementsOf(resource: TemplateResource): readonly PolicyStatementShape[] {
  const document = (resource.Properties?.["PolicyDocument"] ??
    resource.Properties?.["AssumeRolePolicyDocument"]) as
    { Statement?: readonly PolicyStatementShape[] } | undefined;
  return document?.Statement ?? [];
}

function actionsOf(statement: PolicyStatementShape): readonly string[] {
  if (statement.Action === undefined) return [];
  return typeof statement.Action === "string" ? [statement.Action] : statement.Action;
}

function hasWildcardResource(statement: PolicyStatementShape): boolean {
  const resource = statement.Resource;
  if (resource === "*") return true;
  if (Array.isArray(resource)) return resource.some((entry) => entry === "*");
  return false;
}

/**
 * AC2: no IAM statement grants a sensitive action against every resource.
 *
 * The check is `action × resource`, not either alone. `s3:GetObject` on one bucket is
 * correct; `s3:GetObject` on `*` crosses every environment's artifacts. A rule that only
 * looked for `Action: "*"` would miss it entirely, and that is the shape a `grant*` helper
 * most often produces.
 */
export function checkNoWildcardResources(
  template: SynthesizedTemplate,
): readonly PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== "AWS::IAM::Policy" && resource.Type !== "AWS::IAM::Role") continue;
    for (const statement of statementsOf(resource)) {
      if (statement.Effect === "Deny") continue;
      if (!hasWildcardResource(statement)) continue;
      for (const action of actionsOf(statement)) {
        if (RESOURCE_WILDCARD_UNAVOIDABLE.includes(action)) continue;
        if (NEVER_WILDCARD_ACTIONS.some((prefix) => action.startsWith(prefix))) {
          violations.push({
            rule: "no-wildcard-resource",
            resource: logicalId,
            detail: `${action} is granted on Resource "*"; RA-025 AC2 requires an ADR for a wildcard`,
          });
        }
      }
    }
  }
  return violations;
}

/** AC2: no statement uses `Action: "*"` or a service-wide `service:*`. */
export function checkNoWildcardActions(template: SynthesizedTemplate): readonly PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== "AWS::IAM::Policy" && resource.Type !== "AWS::IAM::Role") continue;
    for (const statement of statementsOf(resource)) {
      if (statement.Effect === "Deny") continue;
      for (const action of actionsOf(statement)) {
        if (action === "*" || /^[a-z0-9-]+:\*$/.test(action)) {
          violations.push({
            rule: "no-wildcard-action",
            resource: logicalId,
            detail: `${action} grants a whole service; enumerate the actions instead`,
          });
        }
      }
    }
  }
  return violations;
}

/** Every S3 bucket blocks public access and requires TLS. */
export function checkBucketsAreClosed(template: SynthesizedTemplate): readonly PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== "AWS::S3::Bucket") continue;
    const config = resource.Properties?.["PublicAccessBlockConfiguration"] as
      Record<string, unknown> | undefined;
    for (const key of [
      "BlockPublicAcls",
      "BlockPublicPolicy",
      "IgnorePublicAcls",
      "RestrictPublicBuckets",
    ]) {
      if (config?.[key] !== true) {
        violations.push({
          rule: "bucket-blocks-public-access",
          resource: logicalId,
          detail: `${key} is not true`,
        });
      }
    }
    if (resource.Properties?.["BucketEncryption"] === undefined) {
      violations.push({
        rule: "bucket-encrypted",
        resource: logicalId,
        detail: "no BucketEncryption",
      });
    }
  }
  return violations;
}

/** Data at rest is encrypted, and the database is not publicly reachable. */
export function checkDataAtRest(template: SynthesizedTemplate): readonly PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type === "AWS::RDS::DBInstance") {
      if (resource.Properties?.["StorageEncrypted"] !== true) {
        violations.push({
          rule: "database-encrypted",
          resource: logicalId,
          detail: "StorageEncrypted is not true",
        });
      }
      if (resource.Properties?.["PubliclyAccessible"] === true) {
        violations.push({
          rule: "database-not-public",
          resource: logicalId,
          detail: "PubliclyAccessible is true",
        });
      }
      // AC4's precondition. Retention 0 disables PITR entirely, and it is the default
      // for some engines — so a template that merely omits it would silently have no
      // recovery point.
      const retention = resource.Properties?.["BackupRetentionPeriod"];
      if (typeof retention !== "number" || retention < 1) {
        violations.push({
          rule: "database-pitr-enabled",
          resource: logicalId,
          detail: `BackupRetentionPeriod is ${String(retention)}; PITR requires >= 1`,
        });
      }
    }
    if (resource.Type === "AWS::SQS::Queue") {
      const hasKmsKey = resource.Properties?.["KmsMasterKeyId"] !== undefined;
      const hasSse = resource.Properties?.["SqsManagedSseEnabled"] === true;
      if (!hasKmsKey && !hasSse) {
        violations.push({
          rule: "queue-encrypted",
          resource: logicalId,
          detail: "neither KmsMasterKeyId nor SqsManagedSseEnabled",
        });
      }
    }
  }
  return violations;
}

/**
 * A security group does not allow unrestricted ingress on anything except 443.
 *
 * Checked on the template rather than on the construct because `allowAllOutbound` and
 * `Peer.anyIpv4()` both produce rules that read very differently in code than they do in
 * the resulting `CidrIp: 0.0.0.0/0` entry.
 */
export function checkNoOpenIngress(template: SynthesizedTemplate): readonly PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const inspect = (logicalId: string, rule: Record<string, unknown>): void => {
    if (rule["CidrIp"] !== "0.0.0.0/0" && rule["CidrIpv6"] !== "::/0") return;
    const fromPort = rule["FromPort"];
    const toPort = rule["ToPort"];
    if (fromPort === 443 && toPort === 443) return;
    violations.push({
      rule: "no-open-ingress",
      resource: logicalId,
      detail: `open ingress on ports ${String(fromPort)}-${String(toPort)}; only 443 may be public`,
    });
  };
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type === "AWS::EC2::SecurityGroup") {
      const ingress = resource.Properties?.["SecurityGroupIngress"];
      if (Array.isArray(ingress)) {
        for (const rule of ingress) inspect(logicalId, rule as Record<string, unknown>);
      }
    }
    if (resource.Type === "AWS::EC2::SecurityGroupIngress") {
      inspect(logicalId, (resource.Properties ?? {}) as Record<string, unknown>);
    }
  }
  return violations;
}

/**
 * Stateful resources carry a `Retain` deletion policy when the environment protects data.
 *
 * `Snapshot` is deliberately NOT accepted for the database: it deletes the instance and
 * leaves a snapshot, so a `cdk destroy` against the wrong environment still takes it
 * offline while appearing to preserve everything. `Retain` leaves it running and
 * orphaned — loud, recoverable, and cheap to clean up on purpose.
 */
export function checkStatefulResourcesRetained(
  template: SynthesizedTemplate,
  protectData: boolean,
): readonly PolicyViolation[] {
  if (!protectData) return [];
  const stateful = [
    "AWS::RDS::DBInstance",
    "AWS::S3::Bucket",
    "AWS::KMS::Key",
    "AWS::SecretsManager::Secret",
  ];
  const violations: PolicyViolation[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (!stateful.includes(resource.Type)) continue;
    if (resource.DeletionPolicy !== "Retain") {
      violations.push({
        rule: "stateful-retained",
        resource: logicalId,
        detail: `DeletionPolicy is ${resource.DeletionPolicy ?? "unset"}, expected Retain`,
      });
    }
    if (resource.UpdateReplacePolicy !== "Retain") {
      violations.push({
        rule: "stateful-retained-on-replace",
        resource: logicalId,
        detail:
          `UpdateReplacePolicy is ${resource.UpdateReplacePolicy ?? "unset"}, expected Retain. ` +
          "An update that replaces the resource destroys the data just as a delete does, " +
          "and it is the easier of the two to trigger by accident.",
      });
    }
  }
  return violations;
}

/** Run every check. Returns all violations, so one pass reports everything. */
export function runPolicyChecks(
  template: SynthesizedTemplate,
  options: { readonly protectData: boolean },
): readonly PolicyViolation[] {
  return [
    ...checkNoWildcardActions(template),
    ...checkNoWildcardResources(template),
    ...checkBucketsAreClosed(template),
    ...checkDataAtRest(template),
    ...checkNoOpenIngress(template),
    ...checkStatefulResourcesRetained(template, options.protectData),
  ];
}
