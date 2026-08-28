import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { canonicalDigest, sha256Digest } from "@remoteagent/contracts";
import * as z from "zod";

const boundedName = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u);
const boundedVersion = z.string().regex(/^[A-Za-z0-9.+_-]{1,128}$/u);
const opaqueSessionId = z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/u);
const modelName = z.string().regex(/^[A-Za-z0-9._:/-]{1,256}$/u);
const absoluteExecutable = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && !value.includes("\0"), "must be an absolute path");

export const subscriptionModelProviderKind = z.enum(["codex_cli", "claude_code"]);
export type SubscriptionModelProviderKind = z.infer<typeof subscriptionModelProviderKind>;

export const subscriptionModelRole = z.enum(["DESIGNER", "IMPLEMENTER", "REVIEWER", "VERIFIER"]);
export type SubscriptionModelRole = z.infer<typeof subscriptionModelRole>;

export const subscriptionModelProfileV1 = z
  .object({
    schema_version: z.literal(1),
    profile_name: boundedName,
    provider: subscriptionModelProviderKind,
    executable: absoluteExecutable,
    model: modelName,
    timeout_ms: z.number().int().min(1_000).max(3_600_000),
    kill_grace_ms: z.number().int().min(10).max(10_000),
    max_stdin_bytes: z
      .number()
      .int()
      .min(1)
      .max(4 * 1024 * 1024),
    max_stdout_bytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024),
    max_stderr_bytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024),
  })
  .strict();
export type SubscriptionModelProfileV1 = z.infer<typeof subscriptionModelProfileV1>;

export const subscriptionModelDeploymentConfigV1 = z
  .object({
    schema_version: z.literal(1),
    profiles: z.array(subscriptionModelProfileV1).min(1).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    const names = value.profiles.map((profile) => profile.profile_name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", path: ["profiles"], message: "profile names must be unique" });
    }
    if (names.some((name, index) => index > 0 && names[index - 1]! >= name)) {
      ctx.addIssue({ code: "custom", path: ["profiles"], message: "profiles must be sorted" });
    }
  });
export type SubscriptionModelDeploymentConfigV1 = z.infer<
  typeof subscriptionModelDeploymentConfigV1
>;

export type LoadedSubscriptionModelDeployment = Readonly<{
  config: SubscriptionModelDeploymentConfigV1;
  configDigest: string;
  profiles: ReadonlyMap<string, SubscriptionModelProfileV1>;
}>;

class ImmutableProfileMap implements ReadonlyMap<string, SubscriptionModelProfileV1> {
  readonly #values: Map<string, SubscriptionModelProfileV1>;
  readonly [Symbol.toStringTag] = "Map";

  constructor(entries: Iterable<readonly [string, SubscriptionModelProfileV1]>) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: string): SubscriptionModelProfileV1 | undefined {
    return this.#values.get(key);
  }

  has(key: string): boolean {
    return this.#values.has(key);
  }

  entries(): MapIterator<[string, SubscriptionModelProfileV1]> {
    return this.#values.entries();
  }

  keys(): MapIterator<string> {
    return this.#values.keys();
  }

  values(): MapIterator<SubscriptionModelProfileV1> {
    return this.#values.values();
  }

  forEach(
    callbackfn: (
      value: SubscriptionModelProfileV1,
      key: string,
      map: ReadonlyMap<string, SubscriptionModelProfileV1>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[string, SubscriptionModelProfileV1]> {
    return this.entries();
  }
}

function freezeProfile(profile: SubscriptionModelProfileV1): SubscriptionModelProfileV1 {
  return Object.freeze({ ...profile });
}

export function normalizeSubscriptionModelDeploymentConfig(
  input: unknown,
): LoadedSubscriptionModelDeployment {
  const parsed = subscriptionModelDeploymentConfigV1.parse(input);
  const profiles = parsed.profiles.map(freezeProfile);
  Object.freeze(profiles);
  const config: SubscriptionModelDeploymentConfigV1 = { schema_version: 1, profiles };
  Object.freeze(config);
  return Object.freeze({
    config,
    configDigest: canonicalDigest(config),
    profiles: new ImmutableProfileMap(
      profiles.map((profile) => [profile.profile_name, profile] as const),
    ),
  });
}

/** Load one canonical deployment document. Profile executables are rechecked before every spawn. */
export async function loadSubscriptionModelDeploymentConfig(
  path: string,
): Promise<LoadedSubscriptionModelDeployment> {
  if (!isAbsolute(path)) throw new Error("subscription model config path must be absolute");
  const canonicalPath = await realpath(path);
  if (canonicalPath !== path) throw new Error("subscription model config path must be canonical");
  return normalizeSubscriptionModelDeploymentConfig(JSON.parse(await readFile(path, "utf8")));
}

export const subscriptionAuthPreflightResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("SUBSCRIPTION_AUTHENTICATED"),
      provider: subscriptionModelProviderKind,
      profile_name: boundedName,
      client_version: boundedVersion,
      model: modelName,
    })
    .strict(),
  z
    .object({
      status: z.enum([
        "AUTH_REQUIRED",
        "API_CREDENTIALS_PRESENT",
        "UNSUPPORTED_CLIENT",
        "PREFLIGHT_FAILED",
      ]),
      reason_code: boundedName,
    })
    .strict(),
]);
export type SubscriptionAuthPreflightResult = z.infer<typeof subscriptionAuthPreflightResult>;

export interface SubscriptionAuthPreflight {
  verify(input: {
    profile: SubscriptionModelProfileV1;
    signal?: AbortSignal;
  }): Promise<SubscriptionAuthPreflightResult>;
}

export const subscriptionModelInvocationDescriptorV1 = z
  .object({
    schema_version: z.literal(1),
    role: subscriptionModelRole,
    provider: subscriptionModelProviderKind,
    profile_name: boundedName,
    client_version: boundedVersion,
    model: modelName,
    executable_digest: sha256Digest,
    deployment_config_digest: sha256Digest,
    profile_config_digest: sha256Digest,
  })
  .strict();
export type SubscriptionModelInvocationDescriptorV1 = z.infer<
  typeof subscriptionModelInvocationDescriptorV1
>;

export function createSubscriptionModelInvocationDescriptor(input: {
  role: SubscriptionModelRole;
  profile: SubscriptionModelProfileV1;
  clientVersion: string;
  deploymentConfigDigest: string;
}): SubscriptionModelInvocationDescriptorV1 {
  return subscriptionModelInvocationDescriptorV1.parse({
    schema_version: 1,
    role: input.role,
    provider: input.profile.provider,
    profile_name: input.profile.profile_name,
    client_version: input.clientVersion,
    model: input.profile.model,
    executable_digest: canonicalDigest(input.profile.executable),
    deployment_config_digest: input.deploymentConfigDigest,
    profile_config_digest: canonicalDigest(input.profile),
  });
}

export const subscriptionModelUsage = z
  .object({
    input_tokens: z.number().int().nonnegative().nullable(),
    output_tokens: z.number().int().nonnegative().nullable(),
    total_tokens: z.number().int().nonnegative().nullable(),
    provider_reported: z.boolean(),
  })
  .strict();
export type SubscriptionModelUsage = z.infer<typeof subscriptionModelUsage>;

export const subscriptionModelTerminalOutcome = z.enum([
  "SUCCEEDED",
  "FAILED",
  "AUTH_REQUIRED",
  "API_CREDENTIALS_PRESENT",
  "UNSUPPORTED_CLIENT",
  "PREFLIGHT_FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "OUTPUT_LIMIT_EXCEEDED",
  "START_FAILED",
]);
export type SubscriptionModelTerminalOutcome = z.infer<typeof subscriptionModelTerminalOutcome>;

/** Content-free provider events. Prompt, prose, stdout/stderr and credentials are not representable. */
export const normalizedSubscriptionModelEvent = z.discriminatedUnion("event", [
  z
    .object({ event: z.literal("PREFLIGHT_STARTED"), sequence: z.number().int().positive() })
    .strict(),
  z
    .object({
      event: z.literal("PREFLIGHT_FINISHED"),
      sequence: z.number().int().positive(),
      status: subscriptionAuthPreflightResult.options[0].shape.status
        .or(subscriptionAuthPreflightResult.options[1].shape.status)
        .or(z.enum(["TIMED_OUT", "CANCELLED"])),
    })
    .strict(),
  z.object({ event: z.literal("PROCESS_STARTED"), sequence: z.number().int().positive() }).strict(),
  z
    .object({
      event: z.literal("PROCESS_EXITED"),
      sequence: z.number().int().positive(),
      outcome: subscriptionModelTerminalOutcome,
      exit_code: z.number().int().nullable(),
      signal: boundedName.nullable(),
    })
    .strict(),
  z
    .object({
      event: z.literal("MODEL_SESSION_STARTED"),
      sequence: z.number().int().positive(),
      provider: subscriptionModelProviderKind,
      session_id: opaqueSessionId,
    })
    .strict(),
  z
    .object({
      event: z.literal("MODEL_TURN_FINISHED"),
      sequence: z.number().int().positive(),
      provider: subscriptionModelProviderKind,
      session_id: opaqueSessionId.nullable(),
      outcome: z.enum([
        "SUCCEEDED",
        "AUTH_FAILED",
        "QUOTA_OR_PROVIDER_FAILED",
        "PROVIDER_FAILED",
        "MALFORMED_OUTPUT",
        "TOOL_BOUNDARY_VIOLATION",
      ]),
      usage: subscriptionModelUsage.nullable(),
    })
    .strict(),
]);
export type NormalizedSubscriptionModelEvent = z.infer<typeof normalizedSubscriptionModelEvent>;
