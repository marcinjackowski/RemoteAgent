import { randomUUID } from "node:crypto";
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

import {
  CLAUDE_CODE_MCP_CONFIG_FILENAME,
  CLAUDE_CODE_SETTINGS_FILENAME,
  createClaudePrintArgv,
  serializeClaudeCodeMcpConfig,
  serializeClaudeCodeSettings,
} from "./invocation.js";
import { createClaudeSubscriptionAuthPreflight } from "./preflight.js";
import { createClaudeResponseContract, serializeClaudeRuntimeRequest } from "./schema.js";
import { parseClaudeStreamJsonTranscript } from "./transcript.js";

const MAX_SCHEMA_BYTES = 32 * 1024;

export type ClaudeCodeTransportOptions = Readonly<{
  profile: SubscriptionModelProfileV1;
  preflight?: SubscriptionAuthPreflight;
  environment?: NodeJS.ProcessEnv;
  temporaryParent?: string;
  onEvent?: (event: NormalizedSubscriptionModelEvent) => void;
  sessionIdFactory?: () => string;
}>;

function processFailure(outcome: string): Error {
  if (outcome === "CANCELLED") return new RuntimeCancelledError("Claude Code invocation cancelled");
  if (outcome === "TIMED_OUT") return new RuntimeTimeoutError("Claude Code invocation timed out");
  return new TransportError(`Claude Code invocation refused with ${outcome}`, "FATAL");
}

export class ClaudeCodeTransport implements RuntimeTransport {
  readonly #profile: SubscriptionModelProfileV1;
  readonly #preflight: SubscriptionAuthPreflight;
  readonly #environment: NodeJS.ProcessEnv | undefined;
  readonly #temporaryParent: string;
  readonly #onEvent: ((event: NormalizedSubscriptionModelEvent) => void) | undefined;
  readonly #sessionIdFactory: () => string;

  constructor(options: ClaudeCodeTransportOptions) {
    const profile = subscriptionModelProfileV1.parse(options.profile);
    if (profile.provider !== "claude_code") {
      throw new ConfigurationError("Claude transport requires a claude_code profile");
    }
    const temporaryParent = options.temporaryParent ?? tmpdir();
    if (!isAbsolute(temporaryParent)) {
      throw new ConfigurationError("Claude temporary parent must be absolute");
    }
    this.#profile = Object.freeze({ ...profile });
    this.#preflight = options.preflight ?? createClaudeSubscriptionAuthPreflight();
    this.#environment = options.environment;
    this.#temporaryParent = temporaryParent;
    this.#onEvent = options.onEvent;
    this.#sessionIdFactory = options.sessionIdFactory ?? randomUUID;
  }

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
      throw new ConfigurationError(`Claude subscription preflight refused with ${result.status}`);
    }
    const expected = createSubscriptionModelInvocationDescriptor({
      role: input.invocation.role,
      profile: this.#profile,
      clientVersion: result.client_version,
      deploymentConfigDigest: input.invocation.deployment_config_digest,
    });
    if (canonicalDigest(expected) !== canonicalDigest(input.invocation)) {
      throw new ConfigurationError(
        "Claude subscription invocation identity does not match preflight",
      );
    }
  }

  async converse(request: RuntimeRequest, config: RuntimeConfig): Promise<RuntimeResponse> {
    if (config.model.provider !== "claude_code" || config.model.model_id !== this.#profile.model) {
      throw new ConfigurationError("Claude transport model identity does not match its profile");
    }
    const contract = createClaudeResponseContract(request);
    const schema = JSON.stringify(contract.schema);
    const schemaBytes = Buffer.byteLength(schema, "utf8");
    if (schemaBytes < 2 || schemaBytes > MAX_SCHEMA_BYTES) {
      throw new ConfigurationError("Claude output schema exceeds its argv boundary");
    }

    const parent = await realpath(this.#temporaryParent);
    const invocationRoot = await mkdtemp(join(parent, "remoteagent-claude-"));
    let sequence = 0;
    const emit = (event: NormalizedSubscriptionModelEvent) => {
      sequence += 1;
      this.#onEvent?.(normalizedSubscriptionModelEvent.parse({ ...event, sequence }));
    };
    try {
      const settingsPath = join(invocationRoot, CLAUDE_CODE_SETTINGS_FILENAME);
      const mcpConfigPath = join(invocationRoot, CLAUDE_CODE_MCP_CONFIG_FILENAME);
      await Promise.all([
        writeFile(settingsPath, serializeClaudeCodeSettings(), { mode: 0o600, flag: "wx" }),
        writeFile(mcpConfigPath, serializeClaudeCodeMcpConfig(), { mode: 0o600, flag: "wx" }),
      ]);
      const sessionId = this.#sessionIdFactory();
      const argv = createClaudePrintArgv({
        profile: this.#profile,
        invocationRoot,
        settingsPath,
        mcpConfigPath,
        outputSchemaJson: schema,
        sessionId,
      });
      const result = await runSubscriptionProcess({
        profile: this.#profile,
        argv,
        stdin: serializeClaudeRuntimeRequest({ request, contract }),
        cwd: invocationRoot,
        ...(this.#environment === undefined ? {} : { environment: this.#environment }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        preflight: this.#preflight,
        onEvent: emit,
      });
      if (
        (result.outcome !== "SUCCEEDED" && result.outcome !== "FAILED") ||
        result.clientVersion === null ||
        (result.outcome === "FAILED" && result.stdout.length === 0)
      ) {
        throw processFailure(result.outcome);
      }
      const parsed = parseClaudeStreamJsonTranscript({
        stdout: result.stdout,
        contract,
        expectedSessionId: sessionId,
        expectedModel: this.#profile.model,
        expectedClientVersion: result.clientVersion,
        expectedCwd: invocationRoot,
        processSucceeded: result.outcome === "SUCCEEDED" && result.exitCode === 0,
        nextSequence: () => ++sequence,
        ...(this.#onEvent === undefined ? {} : { onEvent: this.#onEvent }),
      });
      return Object.freeze({
        model: Object.freeze({ provider: "claude_code", model_id: this.#profile.model }),
        content: parsed.content,
        usage: parsed.usage,
        requestId: parsed.sessionId,
      });
    } finally {
      await rm(invocationRoot, { recursive: true, force: true });
    }
  }
}

export function createClaudeCodeTransport(
  options: ClaudeCodeTransportOptions,
): ClaudeCodeTransport {
  return new ClaudeCodeTransport(options);
}
