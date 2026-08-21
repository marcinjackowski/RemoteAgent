/**
 * Queues, DLQ and the four AC4 alarms (RA-025-WU-04).
 *
 * WHAT THESE QUEUES ARE AND ARE NOT. PostgreSQL holds the authoritative job queue
 * (`jobs`, `job_attempts`, `outbox`), with leases, fencing tokens and a DLQ column.
 * These SQS queues are **transport**, not authority — they wake a worker up. That
 * distinction is load-bearing: if SQS were the queue of record, a redelivered message
 * would be a second execution, whereas here it is a second attempt to claim a lease
 * that the database will refuse.
 *
 * So the SQS DLQ is a *transport* dead letter, and it is NOT the DLQ the AC4 alarm
 * watches. That alarm reads the database's `dlq_depth`, published as a custom metric by
 * the worker, because a job that exhausted its retries is a database fact. Watching
 * only the SQS DLQ would miss every job that failed after being claimed — which is
 * most of them.
 *
 * THE FOUR ALARMS MIRROR `packages/observability/src/alerts.ts` EXACTLY, by design.
 * RA-024 made those four classes code rather than dashboard config precisely so they
 * could be tested and would survive a restore. These CloudWatch alarms consume the same
 * metric names, so there is one definition of "what is wrong" and two places that
 * react — rather than two definitions that drift.
 */
import { Duration, Stack, Tags, type StackProps } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
  type IAlarmAction,
} from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import type { IKey } from "aws-cdk-lib/aws-kms";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

import {
  Component,
  resourceName,
  stackName,
  standardTags,
  type EnvironmentConfig,
} from "./config.js";

/** The CloudWatch namespace the worker publishes into. */
export const METRIC_NAMESPACE = "RemoteAgent";

/**
 * Metric names, mirroring `packages/observability/src/metrics.ts`.
 *
 * Duplicated as strings rather than imported, and that is a real trade-off worth
 * stating: `infra` may depend on `packages` (the eslint boundary allows it), but a CDK
 * app importing the observability package would pull its whole module graph into synth
 * and make template generation depend on application code. The cost is that these can
 * drift, which is why `test/infra` asserts they match the exported constants.
 */
export const AlarmMetric = {
  DLQ_DEPTH: "dlq.depth",
  RENEWALS_FAILED: "renewals.failed",
  LEASES_STALE: "leases.stale",
  MODEL_INPUT_TOKENS: "model.input_tokens",
  MODEL_OUTPUT_TOKENS: "model.output_tokens",
  QUEUE_DEPTH: "queue.depth",
} as const;

export interface QueueStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly encryptionKey: IKey;
}

export class QueueStack extends Stack {
  public readonly eventQueue: Queue;
  public readonly transportDeadLetterQueue: Queue;
  public readonly alarmTopic: Topic;
  /** The four AC4 alarms, in the order `alerts.ts` defines the classes. */
  public readonly alarms: readonly Alarm[];

  public constructor(scope: Construct, id: string, props: QueueStackProps) {
    super(scope, id, props);
    const { config, encryptionKey } = props;

    this.alarmTopic = new Topic(this, "Alarms", {
      topicName: resourceName(config, Component.OBSERVABILITY, "alarms"),
      displayName: "RemoteAgent operational alarms",
      masterKey: encryptionKey,
    });
    const action: IAlarmAction = new SnsAction(this.alarmTopic);

    this.transportDeadLetterQueue = new Queue(this, "TransportDlq", {
      queueName: resourceName(config, Component.QUEUE, "transport-dlq"),
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
      enforceSSL: true,
      // Fourteen days, the maximum. A transport dead letter is a bug in wake-up
      // delivery, and the whole value of keeping it is being able to read it after a
      // weekend.
      retentionPeriod: Duration.days(14),
    });

    this.eventQueue = new Queue(this, "Events", {
      queueName: resourceName(config, Component.QUEUE, "events"),
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
      enforceSSL: true,
      // Long enough for a worker to claim the database lease and heartbeat, short
      // enough that a dead worker's message returns promptly. The database lease is the
      // real fence, so this only affects latency, not correctness.
      visibilityTimeout: Duration.minutes(5),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: this.transportDeadLetterQueue, maxReceiveCount: 5 },
    });

    const metric = (name: string, statistic: string, period = Duration.minutes(5)): Metric =>
      new Metric({
        namespace: METRIC_NAMESPACE,
        metricName: name,
        statistic,
        period,
        dimensionsMap: { Environment: config.name },
      });

    // AC4 alarm 1 — DLQ. Threshold 1, mirroring `DEFAULT_ALERT_THRESHOLDS.dlqDepth`: a
    // job reaches the DLQ only after exhausting every retry, so it is work the system
    // has definitively abandoned and nothing polls it.
    const dlqAlarm = new Alarm(this, "DlqAlarm", {
      alarmName: resourceName(config, Component.OBSERVABILITY, "dlq"),
      alarmDescription:
        "A job exhausted every retry. List with JobStore.listDeadLettered, read " +
        "attemptHistory, fix the cause, requeue deliberately. Do NOT bulk-requeue: a " +
        "job that dead-lettered after a partial external effect must be reconciled " +
        "against the provider first.",
      metric: metric(AlarmMetric.DLQ_DEPTH, "Maximum"),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      // MISSING is NOT_BREACHING here because a healthy system publishes 0 and a
      // freshly deployed one publishes nothing yet. Below, for the ones where absence
      // is itself suspicious, this is deliberately different.
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // AC4 alarm 2 — renewal failure. The quietest failure in the system: an expired
    // Calendar watch or a credential that failed to refresh keeps READING for a while,
    // so the only symptom is that events stop arriving.
    const renewalAlarm = new Alarm(this, "RenewalFailureAlarm", {
      alarmName: resourceName(config, Component.OBSERVABILITY, "renewal-failure"),
      alarmDescription:
        "A credential or watch renewal failed. Check the connection's health and " +
        "credential expiry, then re-run the renewal. An AMBIGUOUS credential write is " +
        "NOT retried automatically: the provider may already have issued the new " +
        "token, and a blind retry destroys it.",
      metric: metric(AlarmMetric.RENEWALS_FAILED, "Sum"),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // AC4 alarm 3 — stale lease. A lease held past expiry with no heartbeat means a
    // worker died, possibly mid-effect. `CTF-007` found a real production defect here.
    const staleLeaseAlarm = new Alarm(this, "StaleLeaseAlarm", {
      alarmName: resourceName(config, Component.OBSERVABILITY, "stale-lease"),
      alarmDescription:
        "A lease is held past expiry with no heartbeat. The reaper requeues these " +
        "automatically; the alarm exists because a RECURRING stale lease means workers " +
        "are dying rather than finishing. A job whose effect may have landed goes to " +
        "RECONCILING, never straight back to the queue.",
      metric: metric(AlarmMetric.LEASES_STALE, "Maximum"),
      threshold: 1,
      // Two periods, unlike the others: a single stale lease is recovered
      // automatically, so alarming on one instance would train an operator to ignore
      // this alarm — which is worse than not having it.
      evaluationPeriods: 2,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // AC4 alarm 4 — cost anomaly. The tool loop retries and token spend has no natural
    // ceiling, so unbounded growth produces no error and no failing test, only a bill.
    const tokenBudgetPerPeriod = Math.floor(config.monthlyBudgetUsd * 1_000);
    const costAlarm = new Alarm(this, "CostAnomalyAlarm", {
      alarmName: resourceName(config, Component.OBSERVABILITY, "cost-anomaly"),
      alarmDescription:
        "Model token spend is above budget. Compare model.invocations against " +
        "actions.succeeded: a high ratio means the tool loop is retrying without " +
        "converging. The global kill switch stops new external effects immediately " +
        "while preserving reads and evidence.",
      metric: new Metric({
        namespace: METRIC_NAMESPACE,
        metricName: AlarmMetric.MODEL_INPUT_TOKENS,
        statistic: "Sum",
        period: Duration.hours(1),
        dimensionsMap: { Environment: config.name },
      }),
      threshold: tokenBudgetPerPeriod,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    this.alarms = [dlqAlarm, renewalAlarm, staleLeaseAlarm, costAlarm];
    for (const alarm of this.alarms) alarm.addAlarmAction(action);

    // A fifth alarm, not one of AC4's four but the one that catches "the workers are
    // gone". `treatMissingData` is BREACHING here on purpose, and it is the only alarm
    // where that is right: no metric at all means nothing is publishing, which is the
    // total-failure case the other four cannot see because they read counters that a
    // dead system simply stops incrementing.
    const heartbeatAlarm = new Alarm(this, "NoHeartbeatAlarm", {
      alarmName: resourceName(config, Component.OBSERVABILITY, "no-heartbeat"),
      alarmDescription:
        "No queue-depth metric was published. Either every worker is down or metric " +
        "publication is broken; both are outages. Check ECS service events, then the " +
        "readiness endpoint (a database outage makes workers UNREADY but still ALIVE).",
      metric: metric(AlarmMetric.QUEUE_DEPTH, "Maximum", Duration.minutes(5)),
      threshold: 0,
      evaluationPeriods: 3,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.BREACHING,
    });
    heartbeatAlarm.addAlarmAction(action);

    for (const [key, value] of Object.entries(standardTags(config, Component.QUEUE))) {
      Tags.of(this).add(key, value);
    }
  }

  public static idFor(config: EnvironmentConfig): string {
    return stackName(config, Component.QUEUE);
  }
}
