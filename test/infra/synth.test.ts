import {
  AlarmMetric,
  Component,
  ENVIRONMENTS,
  EnvironmentName,
  METRIC_NAMESPACE,
  buildApp,
  checkBucketsAreClosed,
  checkDataAtRest,
  checkNoOpenIngress,
  checkNoWildcardActions,
  checkNoWildcardResources,
  checkStatefulResourcesRetained,
  environment,
  resourceName,
  runPolicyChecks,
  stackName,
  type EnvironmentConfig,
  type SynthesizedTemplate,
} from "@remoteagent/infra-cdk";
import { GaugeName, MetricName } from "@remoteagent/observability";
import { describe, expect, it } from "vitest";

/**
 * Synth determinism and security policy checks (RA-025, AC1 + AC2).
 *
 * NO AWS CREDENTIALS AND NO NETWORK. Every stack states its account and region
 * explicitly, so `app.synth()` is a pure function of this repository's contents. That is
 * what makes AC1 verifiable here rather than only in a deployment pipeline — and it was
 * measured before the stacks were written, not hoped for.
 *
 * Assertions read the SYNTHESISED TEMPLATE, not the construct tree. Those differ, and the
 * gap is where the interesting failures live: an L2 default can add a permission nobody
 * typed, and `grantReadWrite` expands to include `s3:DeleteObject`, which is not visible
 * at the call site. Same reasoning as `CTF-011` — test what deploys.
 */
const IMAGE_TAG = "sha-0123456789abcdef";

function synth(config: EnvironmentConfig): Record<string, SynthesizedTemplate> {
  const built = buildApp({ config, imageTag: IMAGE_TAG });
  const assembly = built.app.synth();
  const templates: Record<string, SynthesizedTemplate> = {};
  for (const component of Object.values(Component)) {
    const name = stackName(config, component);
    const stack = assembly.stacks.find((candidate) => candidate.stackName === name);
    if (stack !== undefined) templates[name] = stack.template as SynthesizedTemplate;
  }
  return templates;
}

const DEV = environment(EnvironmentName.DEV);

describe("AC1: synth is deterministic", () => {
  it("produces byte-identical templates across two independent synths", () => {
    // The whole point: `cdk diff` must mean "someone changed something", not "time
    // passed". A clock, a random id or an env var read during synth breaks this, and the
    // failure is insidious because a diff full of noise trains people to skim it.
    const first = JSON.stringify(synth(DEV));
    const second = JSON.stringify(synth(DEV));
    expect(second).toBe(first);
  });

  it("is deterministic for every environment, not just dev", () => {
    for (const config of Object.values(ENVIRONMENTS)) {
      expect(JSON.stringify(synth(config))).toBe(JSON.stringify(synth(config)));
    }
  });

  it("changes the template when the image tag changes, and only then", () => {
    // A determinism test that passed because the template ignored its inputs would be
    // worthless, so the negative case is asserted too.
    const a = JSON.stringify(synth(DEV));
    const b = JSON.stringify(
      (() => {
        const built = buildApp({ config: DEV, imageTag: "sha-ffffffffffffffff" });
        const assembly = built.app.synth();
        return assembly.stacks.map((stack) => stack.template);
      })(),
    );
    expect(b).not.toBe(a);
  });

  it("pins concrete availability zones rather than Fn::GetAZs", () => {
    // An environment-agnostic stack emits pseudo-parameters instead of real AZs, which
    // both defeats a byte comparison and hides which AZs an environment uses.
    const template = synth(DEV)[stackName(DEV, Component.NETWORK)]!;
    const subnets = Object.values(template.Resources).filter(
      (resource) => resource.Type === "AWS::EC2::Subnet",
    );
    expect(subnets.length).toBeGreaterThan(0);
    for (const subnet of subnets) {
      expect(JSON.stringify(subnet.Properties?.["AvailabilityZone"])).not.toContain("Fn::GetAZs");
    }
  });

  it("embeds no timestamp or random value anywhere in the templates", () => {
    // A structural check on top of the byte comparison: the comparison would also pass if
    // a value were stable within one process but varied between runs, and this catches
    // the shape of that mistake.
    const serialized = JSON.stringify(synth(DEV));
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(serialized).not.toContain(new Date(0).getFullYear().toString() + "-");
  });
});

describe("AC2: security policy checks pass for every environment", () => {
  it.each(Object.values(ENVIRONMENTS).map((config) => [config.name, config] as const))(
    "%s has zero policy violations",
    (_name, config) => {
      const violations = Object.entries(synth(config)).flatMap(([stack, template]) =>
        runPolicyChecks(template, { protectData: config.protectData }).map(
          (violation) => `${stack}: ${violation.rule} ${violation.resource} — ${violation.detail}`,
        ),
      );
      // Listed, not counted, so a failure names what to fix.
      expect(violations).toEqual([]);
    },
  );

  it("no IAM statement grants a wildcard action", () => {
    const templates = synth(DEV);
    for (const template of Object.values(templates)) {
      for (const [logicalId, resource] of Object.entries(template.Resources)) {
        if (resource.Type !== "AWS::IAM::Policy") continue;
        const document = resource.Properties?.["PolicyDocument"] as {
          Statement?: { Action?: string | string[] }[];
        };
        for (const statement of document.Statement ?? []) {
          const actions =
            typeof statement.Action === "string" ? [statement.Action] : (statement.Action ?? []);
          for (const action of actions) {
            expect(action, `${logicalId} grants ${action}`).not.toBe("*");
            expect(action, `${logicalId} grants ${action}`).not.toMatch(/^[a-z0-9-]+:\*$/);
          }
        }
      }
    }
  });
});

describe("the policy checks themselves detect what they claim to", () => {
  /**
   * A check that never fires is indistinguishable from a passing system.
   *
   * Four mutations initially SURVIVED the first version of this suite — disabling the
   * wildcard-resource check, disabling the stateful-retained check, and making the
   * open-ingress check accept any port — because every assertion was of the form
   * "violations is empty", which stays true when the checker is gutted. These feed each
   * check a template that MUST violate it.
   */
  it("checkNoWildcardResources fires on a wildcard secret grant", () => {
    const violations = checkNoWildcardResources({
      Resources: {
        BadPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyDocument: {
              Statement: [
                { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: "*" },
              ],
            },
          },
        },
      },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("no-wildcard-resource");
  });

  it("checkNoWildcardResources allows the enumerated unavoidable actions", () => {
    // The allowlist has to work, or the check is unusable and someone disables it.
    expect(
      checkNoWildcardResources({
        Resources: {
          Ok: {
            Type: "AWS::IAM::Policy",
            Properties: {
              PolicyDocument: {
                Statement: [
                  { Effect: "Allow", Action: "ecr:GetAuthorizationToken", Resource: "*" },
                ],
              },
            },
          },
        },
      }),
    ).toEqual([]);
  });

  it("checkNoWildcardResources ignores a Deny statement", () => {
    // A wildcard DENY is a guardrail, not a grant.
    expect(
      checkNoWildcardResources({
        Resources: {
          Ok: {
            Type: "AWS::IAM::Policy",
            Properties: {
              PolicyDocument: {
                Statement: [{ Effect: "Deny", Action: "s3:*", Resource: "*" }],
              },
            },
          },
        },
      }),
    ).toEqual([]);
  });

  it("checkNoWildcardActions fires on a service-wide action", () => {
    const violations = checkNoWildcardActions({
      Resources: {
        BadPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyDocument: {
              Statement: [{ Effect: "Allow", Action: ["bedrock:*"], Resource: ["arn:x"] }],
            },
          },
        },
      },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("no-wildcard-action");
  });

  it("checkStatefulResourcesRetained fires on an unretained bucket", () => {
    const violations = checkStatefulResourcesRetained(
      { Resources: { B: { Type: "AWS::S3::Bucket", DeletionPolicy: "Delete" } } },
      true,
    );
    expect(violations.map((violation) => violation.rule)).toEqual([
      "stateful-retained",
      "stateful-retained-on-replace",
    ]);
  });

  it("checkStatefulResourcesRetained rejects Snapshot as well as Delete", () => {
    // `Snapshot` sounds safer and is worse: it deletes the instance and leaves a
    // snapshot, so a destroy against the wrong environment still takes it offline while
    // appearing to preserve everything.
    const violations = checkStatefulResourcesRetained(
      {
        Resources: {
          Db: {
            Type: "AWS::RDS::DBInstance",
            DeletionPolicy: "Snapshot",
            UpdateReplacePolicy: "Snapshot",
          },
        },
      },
      true,
    );
    expect(violations.length).toBe(2);
  });

  it("checkStatefulResourcesRetained is a no-op when the environment does not protect data", () => {
    expect(
      checkStatefulResourcesRetained(
        { Resources: { B: { Type: "AWS::S3::Bucket", DeletionPolicy: "Delete" } } },
        false,
      ),
    ).toEqual([]);
  });

  it("checkNoOpenIngress fires on an open non-443 port and allows 443", () => {
    const bad = checkNoOpenIngress({
      Resources: {
        Sg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            SecurityGroupIngress: [{ CidrIp: "0.0.0.0/0", FromPort: 22, ToPort: 22 }],
          },
        },
      },
    });
    expect(bad).toHaveLength(1);
    expect(bad[0]!.rule).toBe("no-open-ingress");

    expect(
      checkNoOpenIngress({
        Resources: {
          Sg: {
            Type: "AWS::EC2::SecurityGroup",
            Properties: {
              SecurityGroupIngress: [{ CidrIp: "0.0.0.0/0", FromPort: 443, ToPort: 443 }],
            },
          },
        },
      }),
    ).toEqual([]);
  });

  it("checkNoOpenIngress catches a standalone SecurityGroupIngress resource", () => {
    // CDK emits cross-referencing rules as separate resources rather than inline, so a
    // check that only read the inline array would miss exactly the rules that link two
    // stacks.
    expect(
      checkNoOpenIngress({
        Resources: {
          Rule: {
            Type: "AWS::EC2::SecurityGroupIngress",
            Properties: { CidrIp: "0.0.0.0/0", FromPort: 8080, ToPort: 8080 },
          },
        },
      }),
    ).toHaveLength(1);
  });

  it("checkDataAtRest fires on an unencrypted, public, PITR-less database", () => {
    const violations = checkDataAtRest({
      Resources: {
        Db: {
          Type: "AWS::RDS::DBInstance",
          Properties: {
            StorageEncrypted: false,
            PubliclyAccessible: true,
            BackupRetentionPeriod: 0,
          },
        },
      },
    });
    expect(violations.map((violation) => violation.rule).sort()).toEqual([
      "database-encrypted",
      "database-not-public",
      "database-pitr-enabled",
    ]);
  });

  it("checkBucketsAreClosed fires on a bucket with public access allowed", () => {
    expect(
      checkBucketsAreClosed({
        Resources: { B: { Type: "AWS::S3::Bucket", Properties: {} } },
      }).length,
    ).toBeGreaterThan(0);
  });

  it("runPolicyChecks reports EVERY violation, not just the first", () => {
    // Fixing ten wildcards should not be a ten-round game.
    const violations = runPolicyChecks(
      {
        Resources: {
          B: { Type: "AWS::S3::Bucket", Properties: {}, DeletionPolicy: "Delete" },
          Db: {
            Type: "AWS::RDS::DBInstance",
            Properties: { StorageEncrypted: false, BackupRetentionPeriod: 0 },
            DeletionPolicy: "Delete",
          },
        },
      },
      { protectData: true },
    );
    expect(violations.length).toBeGreaterThan(4);
    expect(new Set(violations.map((violation) => violation.rule)).size).toBeGreaterThan(2);
  });
});

describe("AC2: IAM roles are separated per component", () => {
  const templates = synth(DEV);
  const compute = templates[stackName(DEV, Component.WORKER)]!;

  /** Every action a role can perform, from its attached policies. */
  function actionsForRole(template: SynthesizedTemplate, roleLogicalIdFragment: string): string[] {
    const actions: string[] = [];
    for (const resource of Object.values(template.Resources)) {
      if (resource.Type !== "AWS::IAM::Policy") continue;
      const roles = JSON.stringify(resource.Properties?.["Roles"] ?? "");
      if (!roles.includes(roleLogicalIdFragment)) continue;
      const document = resource.Properties?.["PolicyDocument"] as {
        Statement?: { Action?: string | string[] }[];
      };
      for (const statement of document.Statement ?? []) {
        const list =
          typeof statement.Action === "string" ? [statement.Action] : (statement.Action ?? []);
        actions.push(...list);
      }
    }
    return actions;
  }

  it("creates three distinct task roles", () => {
    const roleNames = Object.values(compute.Resources)
      .filter((resource) => resource.Type === "AWS::IAM::Role")
      .map((resource) => resource.Properties?.["RoleName"])
      .filter((name): name is string => typeof name === "string");
    for (const component of [Component.WORKER, Component.EXECUTOR, Component.DISCORD]) {
      expect(roleNames).toContain(resourceName(DEV, component, "task-role"));
    }
  });

  it("the EXECUTOR cannot invoke Bedrock", () => {
    // The executor contains no model reasoning at all (`action-executor.ts`), so a
    // Bedrock permission on it could only ever be misuse. This is the assertion that
    // makes "separated per component" mean something rather than being three roles with
    // the same grants.
    const actions = actionsForRole(compute, "executorTaskRole");
    expect(actions.filter((action) => action.startsWith("bedrock:"))).toEqual([]);
  });

  it("the WORKER can invoke Bedrock, enumerated rather than wildcarded", () => {
    const actions = actionsForRole(compute, "workerTaskRole");
    expect(actions).toContain("bedrock:InvokeModel");
    expect(actions).toContain("bedrock:InvokeModelWithResponseStream");
    expect(actions).not.toContain("bedrock:*");
  });

  it("the DISCORD role cannot invoke Bedrock or read an artifact", () => {
    const actions = actionsForRole(compute, "discordTaskRole");
    expect(actions.filter((action) => action.startsWith("bedrock:"))).toEqual([]);
    expect(actions.filter((action) => action.startsWith("s3:"))).toEqual([]);
  });

  it("the WORKER holds no provider connection secret", () => {
    // The worker runs repository code and reads Jira text, both `UNTRUSTED_DATA`. It must
    // not be the component that can read a provider credential. Asserted on the RESOLVED
    // resource ARNs rather than on action names, because the action is the same
    // `secretsmanager:GetSecretValue` that legitimately reads the database credential —
    // so only the resource distinguishes them.
    const secretArns: string[] = [];
    for (const resource of Object.values(compute.Resources)) {
      if (resource.Type !== "AWS::IAM::Policy") continue;
      if (!JSON.stringify(resource.Properties?.["Roles"] ?? "").includes("workerTaskRole"))
        continue;
      const document = resource.Properties?.["PolicyDocument"] as {
        Statement?: { Action?: string | string[]; Resource?: unknown }[];
      };
      for (const statement of document.Statement ?? []) {
        const actions =
          typeof statement.Action === "string" ? [statement.Action] : (statement.Action ?? []);
        if (!actions.some((action) => action.startsWith("secretsmanager:"))) continue;
        secretArns.push(JSON.stringify(statement.Resource));
      }
    }
    // Asserted on the COUNT of granted ARNs, not on slug strings.
    //
    // Cross-stack references synthesise as `Fn::ImportValue` tokens, so the literal
    // `connection-jira` never appears in this template — the first version of this test
    // searched for those strings and a mutation granting the worker all seven connection
    // secrets STAYED GREEN. One resource is the database credential and nothing else.
    expect(secretArns).toHaveLength(1);
    const granted = JSON.parse(secretArns[0]!) as unknown;
    expect(Array.isArray(granted) ? granted.length : 1).toBe(1);
  });

  it("the EXECUTOR does hold provider connection secrets", () => {
    // The counter-case: a test asserting only absences would pass if no role could read
    // anything, which is a broken system rather than a secure one.
    //
    // Counted by ARN COUNT rather than by matching a slug string. Cross-stack references
    // synthesise as `Fn::ImportValue` tokens, so the literal `connection-jira` never
    // appears in the consuming template — my first version of this test asserted on the
    // string and failed for that reason. The seven-secret grant is still checkable: it is
    // the only statement with seven resources.
    const resources: unknown[] = [];
    for (const resource of Object.values(compute.Resources)) {
      if (resource.Type !== "AWS::IAM::Policy") continue;
      if (!JSON.stringify(resource.Properties?.["Roles"] ?? "").includes("executorTaskRole")) {
        continue;
      }
      const document = resource.Properties?.["PolicyDocument"] as {
        Statement?: { Action?: string | string[]; Resource?: unknown }[];
      };
      for (const statement of document.Statement ?? []) {
        const actions =
          typeof statement.Action === "string" ? [statement.Action] : (statement.Action ?? []);
        if (
          actions.includes("secretsmanager:GetSecretValue") &&
          Array.isArray(statement.Resource)
        ) {
          resources.push(...statement.Resource);
        }
      }
    }
    // Seven connections. If the data stack gains an eighth, this fails and someone has to
    // decide deliberately whether the executor should reach it.
    expect(resources).toHaveLength(7);
  });

  it("the INGRESS reads far fewer secrets than the executor", () => {
    // The internet-facing component. A full compromise of it should yield the ability to
    // append to an append-only table, not to act.
    //
    // Compared by COUNT, for the `Fn::ImportValue` reason above: the ingress role's
    // secret statement holds the database credential plus the two webhook signing
    // secrets (Jira, GitLab) — three — against the executor's seven. The specific
    // exclusions (both Gmails, both Calendars, Discord) are enforced at the wiring site
    // in `app.ts`, where the filter is on a literal `slug` union so a typo is a compile
    // error. Which is the better place for it: this test can only see counts.
    const ingress = templates[stackName(DEV, Component.INGRESS)]!;
    const counts: number[] = [];
    for (const resource of Object.values(ingress.Resources)) {
      if (resource.Type !== "AWS::IAM::Policy") continue;
      if (!JSON.stringify(resource.Properties?.["Roles"] ?? "").includes("IngressTaskRole")) {
        continue;
      }
      const document = resource.Properties?.["PolicyDocument"] as {
        Statement?: { Action?: string | string[]; Resource?: unknown }[];
      };
      for (const statement of document.Statement ?? []) {
        const actions =
          typeof statement.Action === "string" ? [statement.Action] : (statement.Action ?? []);
        if (actions.includes("secretsmanager:GetSecretValue")) {
          counts.push(Array.isArray(statement.Resource) ? statement.Resource.length : 1);
        }
      }
    }
    expect(counts).toEqual([3]);
  });

  it("the INGRESS may send to the queue but never consume from it", () => {
    // A component reachable from the internet that could claim jobs would be able to
    // influence which work runs.
    const ingress = templates[stackName(DEV, Component.INGRESS)]!;
    const actions: string[] = [];
    for (const resource of Object.values(ingress.Resources)) {
      if (resource.Type !== "AWS::IAM::Policy") continue;
      const document = resource.Properties?.["PolicyDocument"] as {
        Statement?: { Action?: string | string[] }[];
      };
      for (const statement of document.Statement ?? []) {
        const list =
          typeof statement.Action === "string" ? [statement.Action] : (statement.Action ?? []);
        actions.push(...list);
      }
    }
    expect(actions).toContain("sqs:SendMessage");
    expect(actions).not.toContain("sqs:ReceiveMessage");
  });
});

describe("the four AC4 alarms exist and match the observability metric names", () => {
  const queue = synth(DEV)[stackName(DEV, Component.QUEUE)]!;

  function alarms(): { name: string; metric: string; threshold: unknown; missing: unknown }[] {
    return Object.values(queue.Resources)
      .filter((resource) => resource.Type === "AWS::CloudWatch::Alarm")
      .map((resource) => ({
        name: String(resource.Properties?.["AlarmName"]),
        metric: String(resource.Properties?.["MetricName"]),
        threshold: resource.Properties?.["Threshold"],
        missing: resource.Properties?.["TreatMissingData"],
      }));
  }

  it("has an alarm for each of the four AC4 classes", () => {
    const names = alarms().map((alarm) => alarm.name);
    for (const suffix of ["dlq", "renewal-failure", "stale-lease", "cost-anomaly"]) {
      expect(names).toContain(resourceName(DEV, Component.OBSERVABILITY, suffix));
    }
  });

  it("uses the SAME metric names the observability package publishes", () => {
    // `infra` duplicates these as strings to keep synth independent of application code,
    // so this is the test that keeps the two from drifting — which is the cost of the
    // duplication, paid explicitly.
    expect(AlarmMetric.DLQ_DEPTH).toBe(GaugeName.DLQ_DEPTH);
    expect(AlarmMetric.LEASES_STALE).toBe(GaugeName.LEASES_STALE);
    expect(AlarmMetric.QUEUE_DEPTH).toBe(GaugeName.QUEUE_DEPTH);
    expect(AlarmMetric.RENEWALS_FAILED).toBe(MetricName.RENEWALS_FAILED);
    expect(AlarmMetric.MODEL_INPUT_TOKENS).toBe(MetricName.MODEL_INPUT_TOKENS);
    expect(AlarmMetric.MODEL_OUTPUT_TOKENS).toBe(MetricName.MODEL_OUTPUT_TOKENS);
  });

  it("publishes into one namespace", () => {
    for (const resource of Object.values(queue.Resources)) {
      if (resource.Type !== "AWS::CloudWatch::Alarm") continue;
      expect(resource.Properties?.["Namespace"]).toBe(METRIC_NAMESPACE);
    }
  });

  it("mirrors the DLQ threshold of 1 from DEFAULT_ALERT_THRESHOLDS", () => {
    const dlq = alarms().find((alarm) => alarm.name.endsWith("-dlq"));
    expect(dlq?.threshold).toBe(1);
  });

  it("treats missing data as BREACHING only for the no-heartbeat alarm", () => {
    // The distinction matters: for a counter, absence means "nothing bad happened yet".
    // For the heartbeat, absence means nothing is publishing at all — the total-failure
    // case the other four cannot see, because a dead system simply stops incrementing.
    for (const alarm of alarms()) {
      const expected = alarm.name.endsWith("no-heartbeat") ? "breaching" : "notBreaching";
      expect(alarm.missing, `${alarm.name}`).toBe(expected);
    }
  });

  it("routes every alarm to the SNS topic", () => {
    // An alarm with no action is a dashboard widget.
    for (const resource of Object.values(queue.Resources)) {
      if (resource.Type !== "AWS::CloudWatch::Alarm") continue;
      const actions = resource.Properties?.["AlarmActions"];
      expect(
        Array.isArray(actions) && actions.length > 0,
        String(resource.Properties?.["AlarmName"]),
      ).toBe(true);
    }
  });
});

describe("environment promotion boundaries", () => {
  it("gives every environment a distinct account", () => {
    // The boundary is the account, not the name prefix. A prefix has never stopped anyone
    // typing the wrong `--profile`.
    const accounts = Object.values(ENVIRONMENTS).map((config) => config.account);
    expect(new Set(accounts).size).toBe(accounts.length);
  });

  it("marks prod as NOT deployable without a separate owner decision", () => {
    expect(ENVIRONMENTS[EnvironmentName.PROD].deployable).toBe(false);
  });

  it("refuses an unknown environment rather than defaulting to dev", () => {
    // Failing closed matters most for the typo that happened while targeting prod.
    expect(() => environment("staging")).toThrow(/unknown environment/);
  });

  it("gives prod the longest PITR window and drill the shortest", () => {
    expect(ENVIRONMENTS[EnvironmentName.PROD].pitrRetentionDays).toBeGreaterThan(
      ENVIRONMENTS[EnvironmentName.DEV].pitrRetentionDays,
    );
    expect(ENVIRONMENTS[EnvironmentName.DRILL].pitrRetentionDays).toBeLessThanOrEqual(
      ENVIRONMENTS[EnvironmentName.DEV].pitrRetentionDays,
    );
  });

  it("protects data in dev and prod, and deliberately does not in drill", () => {
    expect(ENVIRONMENTS[EnvironmentName.DEV].protectData).toBe(true);
    expect(ENVIRONMENTS[EnvironmentName.PROD].protectData).toBe(true);
    // A drill environment that cannot be torn down is a drill nobody runs, and an unrun
    // drill is the failure AC4 exists to prevent.
    expect(ENVIRONMENTS[EnvironmentName.DRILL].protectData).toBe(false);
  });

  it("tags every stack with its environment and component", () => {
    // A cost report or an incident query that cannot separate dev from prod is useless.
    for (const [name, template] of Object.entries(synth(DEV))) {
      const tagged = Object.values(template.Resources).some((resource) =>
        JSON.stringify(resource.Properties?.["Tags"] ?? "").includes("remoteagent:environment"),
      );
      expect(tagged, `${name} has no environment tag`).toBe(true);
    }
  });
});

describe("network egress is enumerable", () => {
  const network = synth(DEV)[stackName(DEV, Component.NETWORK)]!;

  it("puts the database in an isolated subnet with no NAT route", () => {
    const routes = Object.values(network.Resources).filter(
      (resource) => resource.Type === "AWS::EC2::Route",
    );
    const natRoutes = routes.filter((route) => route.Properties?.["NatGatewayId"] !== undefined);
    // NAT routes exist (workers need egress) but there are fewer of them than there are
    // route tables, which is what "the isolated subnet has none" looks like in a template.
    expect(natRoutes.length).toBeGreaterThan(0);
    const tables = Object.values(network.Resources).filter(
      (resource) => resource.Type === "AWS::EC2::RouteTable",
    );
    expect(natRoutes.length).toBeLessThan(tables.length);
  });

  it("enables VPC flow logs", () => {
    // After an incident, "what did this task talk to?" is unanswerable without them, and
    // it is the question that decides whether a credential leaked.
    const flowLogs = Object.values(network.Resources).filter(
      (resource) => resource.Type === "AWS::EC2::FlowLog",
    );
    expect(flowLogs.length).toBeGreaterThan(0);
  });

  it("creates an interface endpoint for Secrets Manager", () => {
    // A credential fetch must not traverse the internet. An endpoint removes the
    // possibility rather than mitigating it.
    const services = Object.values(network.Resources)
      .filter((resource) => resource.Type === "AWS::EC2::VPCEndpoint")
      .map((resource) => JSON.stringify(resource.Properties?.["ServiceName"]));
    expect(services.some((service) => service.includes("secretsmanager"))).toBe(true);
  });

  it("restricts the S3 gateway endpoint to this environment's own bucket", () => {
    // The second authorization boundary: a task with over-broad IAM still cannot reach
    // another environment's artifacts through this route.
    const endpoints = Object.values(network.Resources).filter(
      (resource) => resource.Type === "AWS::EC2::VPCEndpoint",
    );
    const s3 = endpoints.find((endpoint) =>
      JSON.stringify(endpoint.Properties?.["ServiceName"]).includes("s3"),
    );
    const policy = JSON.stringify(s3?.Properties?.["PolicyDocument"] ?? "");
    expect(policy).toContain(resourceName(DEV, Component.DATA, "artifacts"));
    expect(policy).not.toContain('"Resource":"*"');
  });

  it("allows public ingress only on 443, and only on the load balancer", () => {
    const ingress = synth(DEV)[stackName(DEV, Component.INGRESS)]!;
    const open: string[] = [];
    for (const [logicalId, resource] of Object.entries({
      ...network.Resources,
      ...ingress.Resources,
    })) {
      if (resource.Type !== "AWS::EC2::SecurityGroup") continue;
      const rules = resource.Properties?.["SecurityGroupIngress"];
      if (!Array.isArray(rules)) continue;
      for (const rule of rules as Record<string, unknown>[]) {
        if (rule["CidrIp"] !== "0.0.0.0/0") continue;
        if (rule["FromPort"] === 443 && rule["ToPort"] === 443) continue;
        open.push(`${logicalId}: ${String(rule["FromPort"])}-${String(rule["ToPort"])}`);
      }
    }
    expect(open).toEqual([]);
  });
});

describe("compute health checks use the right probe", () => {
  const compute = synth(DEV)[stackName(DEV, Component.WORKER)]!;
  const ingress = synth(DEV)[stackName(DEV, Component.INGRESS)]!;

  it("ECS restarts on LIVENESS, which does not depend on PostgreSQL", () => {
    // The RA-024 finding applied. Wiring readiness here would restart-loop every worker
    // during a database outage — exactly when their in-flight leases and logs are the
    // only evidence available.
    const definitions = Object.values(compute.Resources).filter(
      (resource) => resource.Type === "AWS::ECS::TaskDefinition",
    );
    expect(definitions.length).toBe(3);
    for (const definition of definitions) {
      const serialized = JSON.stringify(definition.Properties?.["ContainerDefinitions"]);
      expect(serialized).toContain("--liveness");
      expect(serialized).not.toContain("--readiness");
    }
  });

  it("the load balancer routes on READINESS, which does depend on PostgreSQL", () => {
    // The opposite choice, deliberately: a load balancer should stop routing to a task
    // that cannot reach the database, while ECS should not restart it.
    const targetGroups = Object.values(ingress.Resources).filter(
      (resource) => resource.Type === "AWS::ElasticLoadBalancingV2::TargetGroup",
    );
    expect(targetGroups.length).toBe(1);
    expect(targetGroups[0]!.Properties?.["HealthCheckPath"]).toBe("/readyz");
  });

  it("passes the database credential as a secret reference, never as plaintext env", () => {
    // A plaintext credential in a task definition is readable by anyone with
    // `ecs:DescribeTaskDefinition`.
    const serialized = JSON.stringify(compute.Resources);
    expect(serialized).toContain('"Name":"RA_DATABASE_URL"');
    const definitions = Object.values(compute.Resources).filter(
      (resource) => resource.Type === "AWS::ECS::TaskDefinition",
    );
    for (const definition of definitions) {
      const containers = definition.Properties?.["ContainerDefinitions"] as {
        Environment?: { Name: string }[];
      }[];
      for (const container of containers) {
        const envNames = (container.Environment ?? []).map((entry) => entry.Name);
        expect(envNames).not.toContain("RA_DATABASE_URL");
      }
    }
  });

  it("runs exactly one executor and one Discord gateway", () => {
    // Correctness, not scaling: a second Discord gateway receives every interaction
    // twice, and a single executor keeps "which process sent this?" answerable.
    const services = Object.values(compute.Resources).filter(
      (resource) => resource.Type === "AWS::ECS::Service",
    );
    const byName = new Map(
      services.map((service) => [
        String(service.Properties?.["ServiceName"]),
        service.Properties?.["DesiredCount"],
      ]),
    );
    expect(byName.get(resourceName(DEV, Component.EXECUTOR, "service"))).toBe(1);
    expect(byName.get(resourceName(DEV, Component.DISCORD, "service"))).toBe(1);
  });
});
