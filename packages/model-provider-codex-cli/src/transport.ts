import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { canonicalDigest } from "@remoteagent/contracts";
import {
  ConfigurationError,
  createSubscriptionModelInvocationDescriptor,
  normalizedSubscriptionModelEvent,
  RuntimeCancelledError,
  RuntimeTimeoutError,
  runSubscriptionProcess,
  subscriptionAuthPreflightResult,
  subscriptionModelProfileV1,
  TransportError,
  type NormalizedSubscriptionModelEvent,
  type RuntimeConfig,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeTransport,
  type SubscriptionAuthPreflight,
  type SubscriptionModelInvocationDescriptorV1,
  type SubscriptionModelProfileV1,
} from "@remoteagent/model-runtime";

import { CODEX_CLI_RESPONSE_SCHEMA_FILENAME, createCodexExecArgv } from "./invocation.js";
import { createCodexSubscriptionAuthPreflight } from "./preflight.js";
import { createCodexResponseContract, serializeCodexRuntimeRequest } from "./schema.js";
import { parseCodexJsonlTranscript } from "./transcript.js";

const MAX_SCHEMA_BYTES = 1024 * 1024;

export type CodexCliTransportOptions = Readonly<{
  profile: SubscriptionModelProfileV1;
  preflight?: SubscriptionAuthPreflight;
  environment?: NodeJS.ProcessEnv;
  temporaryParent?: string;
  onEvent?: (event: NormalizedSubscriptionModelEvent) => void;
}>;

function processFailure(outcome: string): Error {
  if (outcome === "CANCELLED") return new RuntimeCancelledError("Codex CLI invocation cancelled");
  if (outcome === "TIMED_OUT") return new RuntimeTimeoutError("Codex CLI invocation timed out");
  return new TransportError(`Codex CLI invocation refused with ${outcome}`, "FATAL");
}

export class CodexCliTransport implements RuntimeTransport {
  readonly #profile: SubscriptionModelProfileV1;
  readonly #preflight: SubscriptionAuthPreflight;
  readonly #environment: NodeJS.ProcessEnv | undefined;
  readonly #temporaryParent: string;
  readonly #onEvent: ((event: NormalizedSubscriptionModelEvent) => void) | undefined;

  constructor(options: CodexCliTransportOptions) {
    const profile = subscriptionModelProfileV1.parse(options.profile);
    if (profile.provider !== "codex_cli") {
      throw new ConfigurationError("Codex transport requires a codex_cli profile");
    }
    const temporaryParent = options.temporaryParent ?? tmpdir();
    if (!isAbsolute(temporaryParent)) {
      throw new ConfigurationError("Codex temporary parent must be absolute");
    }
    this.#profile = Object.freeze({ ...profile });
    this.#preflight = options.preflight ?? createCodexSubscriptionAuthPreflight();
    this.#environment = options.environment;
    this.#temporaryParent = temporaryParent;
    this.#onEvent = options.onEvent;
  }

  /** Prove exact subscription identity before an Engineering intent can be persisted. */
  async assertInvocationReady(input: {
    invocation: SubscriptionModelInvocationDescriptorV1;
    signal?: AbortSignal;
  }): Promise<void> {
    const result = subscriptionAuthPreflightResult.parse(
      await this.#preflight.verify({
        profile: this.#profile,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    );
    if (result.status !== "SUBSCRIPTION_AUTHENTICATED") {
      throw new ConfigurationError(`Codex subscription preflight refused with ${result.status}`);
    }
    const expected = createSubscriptionModelInvocationDescriptor({
      role: input.invocation.role,
      profile: this.#profile,
      clientVersion: result.client_version,
      deploymentConfigDigest: input.invocation.deployment_config_digest,
    });
    if (canonicalDigest(expected) !== canonicalDigest(input.invocation)) {
      throw new ConfigurationError(
        "Codex subscription invocation identity does not match preflight",
      );
    }
  }

  async converse(request: RuntimeRequest, config: RuntimeConfig): Promise<RuntimeResponse> {
    if (config.model.provider !== "codex_cli" || config.model.model_id !== this.#profile.model) {
      throw new ConfigurationError("Codex transport model identity does not match its profile");
    }
    const contract = createCodexResponseContract(request);
    const schemaBytes = Buffer.from(JSON.stringify(contract.schema), "utf8");
    if (schemaBytes.byteLength === 0 || schemaBytes.byteLength > MAX_SCHEMA_BYTES) {
      throw new ConfigurationError("Codex output schema exceeds its byte boundary");
    }

    const parent = await realpath(this.#temporaryParent);
    const invocationRoot = await mkdtemp(join(parent, "remoteagent-codex-"));
    let sequence = 0;
    const emit = (event: NormalizedSubscriptionModelEvent) => {
      sequence += 1;
      this.#onEvent?.(normalizedSubscriptionModelEvent.parse({ ...event, sequence }));
    };
    try {
      const outputSchemaPath = join(invocationRoot, CODEX_CLI_RESPONSE_SCHEMA_FILENAME);
      await writeFile(outputSchemaPath, schemaBytes, { mode: 0o600, flag: "wx" });
      const argv = createCodexExecArgv({
        profile: this.#profile,
        invocationRoot,
        outputSchemaPath,
      });
      const result = await runSubscriptionProcess({
        profile: this.#profile,
        argv,
        stdin: serializeCodexRuntimeRequest({ request, contract }),
        cwd: invocationRoot,
        ...(this.#environment === undefined ? {} : { environment: this.#environment }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        preflight: this.#preflight,
        onEvent: emit,
      });
      if (result.outcome !== "SUCCEEDED" || result.exitCode !== 0) {
        throw processFailure(result.outcome);
      }
      const parsed = parseCodexJsonlTranscript({
        stdout: result.stdout,
        contract,
        nextSequence: () => ++sequence,
        ...(this.#onEvent === undefined ? {} : { onEvent: this.#onEvent }),
      });
      return Object.freeze({
        model: Object.freeze({ provider: "codex_cli", model_id: this.#profile.model }),
        content: parsed.content,
        usage: parsed.usage,
        requestId: parsed.sessionId,
      });
    } finally {
      await rm(invocationRoot, { recursive: true, force: true });
    }
  }
}

export function createCodexCliTransport(options: CodexCliTransportOptions): CodexCliTransport {
  return new CodexCliTransport(options);
}
