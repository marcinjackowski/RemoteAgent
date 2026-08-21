/**
 * Network stack (RA-025-WU-02).
 *
 * THE EGRESS SHAPE IS THE SECURITY DECISION HERE, not the subnet layout. This system's
 * whole job is to talk to five external providers and to Bedrock, so "deny all egress"
 * is not available — the question is whether egress is *enumerable*. It is: workers
 * reach AWS services through VPC endpoints (which never leave the AWS network) and
 * reach the five providers through a NAT gateway on port 443 only.
 *
 * WHY VPC ENDPOINTS AND NOT JUST NAT. Three reasons, in order of weight:
 *
 *  1. **Secrets Manager traffic must not traverse the internet.** A credential fetch
 *     going out through NAT and back is the one flow where an egress misconfiguration
 *     has the worst consequence, and an interface endpoint removes the possibility
 *     rather than mitigating it.
 *  2. **An endpoint policy is an additional authorization boundary.** The S3 gateway
 *     endpoint below restricts access to this environment's own bucket, so even a
 *     compromised task with over-broad IAM cannot read another environment's
 *     artifacts through it.
 *  3. Cost, which is real but is the least interesting reason.
 *
 * `natGateways` is 1, not one per AZ, and that is a deliberate availability trade-off
 * rather than an oversight: a NAT per AZ triples the standing cost to protect against
 * a single-AZ failure whose impact here is a delayed job, not a lost one — every job
 * has a lease and a retry schedule. Stated so the next reader does not "fix" it
 * without knowing it was chosen.
 */
import { Stack, Tags, type StackProps } from "aws-cdk-lib";
import {
  FlowLogDestination,
  FlowLogTrafficType,
  GatewayVpcEndpointAwsService,
  InterfaceVpcEndpointAwsService,
  IpAddresses,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

import {
  Component,
  resourceName,
  stackName,
  standardTags,
  type EnvironmentConfig,
} from "./config.js";

export interface NetworkStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

export class NetworkStack extends Stack {
  public readonly vpc: Vpc;
  /** Tasks that may reach providers and AWS services. */
  public readonly workloadSecurityGroup: SecurityGroup;
  /** The database's security group; only the workload group may reach it. */
  public readonly databaseSecurityGroup: SecurityGroup;
  /**
   * The public load balancer's group.
   *
   * Declared here rather than in `IngressStack` because it references
   * {@link workloadSecurityGroup}, and a cross-stack security-group reference in the
   * other direction produces a `DependencyCycle` at synth.
   */
  public readonly loadBalancerSecurityGroup: SecurityGroup;

  public constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.vpc = new Vpc(this, "Vpc", {
      vpcName: resourceName(config, Component.NETWORK, "vpc"),
      ipAddresses: IpAddresses.cidr("10.42.0.0/16"),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        // Public holds ONLY the NAT gateway and the load balancer. No task runs here.
        { name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 },
        // Every task and the database live here: no inbound route from the internet.
        { name: "private", subnetType: SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        // Isolated has NO egress at all. The database sits here so a compromised
        // database host cannot call out — it is the one component with no legitimate
        // reason to initiate an outbound connection.
        { name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      // Flow logs are not optional: after an incident, "what did this task talk to?"
      // is unanswerable without them, and it is the question that decides whether a
      // credential leaked.
      flowLogs: {
        all: {
          destination: FlowLogDestination.toCloudWatchLogs(),
          trafficType: FlowLogTrafficType.ALL,
        },
      },
    });

    this.workloadSecurityGroup = new SecurityGroup(this, "WorkloadSg", {
      vpc: this.vpc,
      securityGroupName: resourceName(config, Component.NETWORK, "workload-sg"),
      description: "Tasks that reach providers over 443 and AWS services via endpoints",
      // Egress is allowed but narrowed below to 443 only. `allowAllOutbound: false`
      // then an explicit rule, rather than the default open egress: this is the one
      // place where the difference between "can reach five providers" and "can reach
      // anything" is decided.
      allowAllOutbound: false,
    });
    this.workloadSecurityGroup.addEgressRule(
      // The five providers and Bedrock are all HTTPS on public endpoints, so the
      // destination cannot be narrowed by IP — provider IP ranges change without
      // notice, and pinning them would produce silent outages. The port restriction is
      // what remains enforceable, and it is worth having: it blocks the plain-HTTP and
      // arbitrary-port exfiltration channels.
      Peer.anyIpv4(),
      Port.tcp(443),
      "HTTPS to providers and AWS APIs",
    );

    // The ALB's security group lives HERE, not in the ingress stack, and that is a
    // cross-stack correctness requirement rather than tidiness: a security group in
    // stack B that references a group in stack A makes A depend on B for the group id
    // while B already depends on A for the VPC. CDK reports that as a
    // `DependencyCycle` at synth — measured, not predicted: the first version put this
    // group in `IngressStack` and synth refused.
    //
    // Every security-group-to-security-group rule therefore lives in this stack, and
    // other stacks receive groups as inputs.
    this.loadBalancerSecurityGroup = new SecurityGroup(this, "AlbSg", {
      vpc: this.vpc,
      securityGroupName: resourceName(config, Component.INGRESS, "alb-sg"),
      description: "Public HTTPS ingress for provider webhooks",
      allowAllOutbound: false,
    });
    // 443 only. Port 80 is deliberately absent rather than redirected: a redirect
    // invites a provider to be configured with an http:// URL, and a webhook delivered
    // over plain HTTP has already leaked its signature header before we can refuse it.
    this.loadBalancerSecurityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(443),
      "HTTPS from providers",
    );
    this.loadBalancerSecurityGroup.addEgressRule(
      this.workloadSecurityGroup,
      Port.tcp(8080),
      "to ingress tasks",
    );
    this.workloadSecurityGroup.addIngressRule(
      this.loadBalancerSecurityGroup,
      Port.tcp(8080),
      "webhook traffic from the load balancer only",
    );

    this.databaseSecurityGroup = new SecurityGroup(this, "DatabaseSg", {
      vpc: this.vpc,
      securityGroupName: resourceName(config, Component.NETWORK, "database-sg"),
      description: "PostgreSQL; reachable only from the workload security group",
      // The database initiates nothing. Not a default — an assertion.
      allowAllOutbound: false,
    });
    this.databaseSecurityGroup.addIngressRule(
      this.workloadSecurityGroup,
      Port.tcp(5432),
      "PostgreSQL from workloads only",
    );

    // Interface endpoints: this traffic never leaves the AWS network.
    for (const [id_, service] of [
      ["SecretsManagerEndpoint", InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ["BedrockEndpoint", InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME],
      ["EcrEndpoint", InterfaceVpcEndpointAwsService.ECR],
      ["EcrDockerEndpoint", InterfaceVpcEndpointAwsService.ECR_DOCKER],
      ["LogsEndpoint", InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ["SqsEndpoint", InterfaceVpcEndpointAwsService.SQS],
      ["KmsEndpoint", InterfaceVpcEndpointAwsService.KMS],
    ] as const) {
      this.vpc.addInterfaceEndpoint(id_, {
        service,
        subnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [this.workloadSecurityGroup],
        privateDnsEnabled: true,
      });
    }

    // S3 through a gateway endpoint, with a policy restricting it to this
    // environment's own artifact bucket. This is the second authorization boundary
    // described in the module comment: a task with over-broad IAM still cannot read
    // another environment's artifacts through this route.
    const s3Endpoint = this.vpc.addGatewayEndpoint("S3Endpoint", {
      service: GatewayVpcEndpointAwsService.S3,
      subnets: [
        { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        { subnetType: SubnetType.PRIVATE_ISOLATED },
      ],
    });
    s3Endpoint.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        principals: [new AnyPrincipal()],
        actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:AbortMultipartUpload"],
        resources: [
          `arn:aws:s3:::${resourceName(config, Component.DATA, "artifacts")}`,
          `arn:aws:s3:::${resourceName(config, Component.DATA, "artifacts")}/*`,
        ],
      }),
    );

    for (const [key, value] of Object.entries(standardTags(config, Component.NETWORK))) {
      Tags.of(this).add(key, value);
    }
  }

  /** Log retention for flow logs, exposed so the observability stack can assert it. */
  public static readonly flowLogRetention = RetentionDays.THREE_MONTHS;

  public static idFor(config: EnvironmentConfig): string {
    return stackName(config, Component.NETWORK);
  }
}
