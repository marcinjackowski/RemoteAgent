/** Credential vaults that never return secret material as a DTO. */
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export class CredentialVaultError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class CredentialNotFoundError extends CredentialVaultError {}
export class CredentialVaultUnavailableError extends CredentialVaultError {}

/**
 * The credential-consuming callback threw. The original error is deliberately
 * NOT retained as message or `cause`: a provider/client callback may embed the
 * decrypted secret in its error, and errors are routinely logged and serialized
 * (AUDIT-01 HIGH-03). Only the safe class name of the original error is kept.
 */
export class CredentialUsageError extends CredentialVaultError {
  public readonly originalName: string | undefined;

  public constructor(originalName?: string) {
    super("credential callback failed");
    this.originalName =
      originalName !== undefined && /^[A-Za-z][A-Za-z0-9_]*$/.test(originalName)
        ? originalName
        : undefined;
  }
}

/**
 * The outcome of a write could not be determined (e.g. create succeeded then the
 * response timed out, or a value-free probe was itself unavailable). The caller
 * MUST reconcile before any automatic replay (AGENTS.md §8; AUDIT-01 HIGH-02).
 */
export class CredentialWriteAmbiguousError extends CredentialVaultError {}

export interface PutCredentialOptions {
  /** Stable idempotency token; reused verbatim across retries of one operation. */
  versionId: string;
}

/** Existence of a vault object, reported WITHOUT exposing the secret value. */
export interface CredentialObjectStatus {
  exists: boolean;
  versionId?: string;
}

export interface CredentialVault {
  put(secretRef: string, secret: Uint8Array, options: PutCredentialOptions): Promise<void>;
  /** Value-free reconciliation probe. Never returns secret bytes. */
  head(secretRef: string): Promise<CredentialObjectStatus>;
  withCredential<T>(secretRef: string, use: (secret: Uint8Array) => Promise<T> | T): Promise<T>;
  revoke(secretRef: string): Promise<void>;
}

/**
 * Invoke a credential-consuming callback, converting ANY throw into a sanitized
 * {@link CredentialUsageError}. Shared by every vault so callback failures are
 * wrapped identically and never carry raw secret-bearing text.
 */
async function runWithSecret<T>(
  use: (secret: Uint8Array) => Promise<T> | T,
  secret: Uint8Array,
): Promise<T> {
  try {
    return await use(secret);
  } catch (error) {
    throw new CredentialUsageError(error instanceof Error ? error.name : undefined);
  }
}

/** Test/development vault. Values are copied and every transient copy is wiped. */
export class LocalCredentialVault implements CredentialVault {
  readonly #values = new Map<string, { bytes: Uint8Array; versionId: string }>();
  #failure: "read" | "write" | "revoke" | "head" | null = null;
  #timeoutAfterWrite = false;

  public failNext(operation: "read" | "write" | "revoke" | "head"): void {
    this.#failure = operation;
  }

  /**
   * Simulate a write that reaches the store and THEN fails to acknowledge (a
   * create-then-timeout). The object persists but `put` rejects, so recovery
   * must reconcile via {@link head} (AUDIT-01 HIGH-02 fault injection).
   */
  public timeoutAfterNextWrite(): void {
    this.#timeoutAfterWrite = true;
  }

  public async put(
    secretRef: string,
    secret: Uint8Array,
    options: PutCredentialOptions,
  ): Promise<void> {
    this.#throwIfFailed("write");
    if (options.versionId.trim() === "") {
      throw new CredentialVaultError("credential version id is required");
    }
    const existing = this.#values.get(secretRef);
    if (existing !== undefined) {
      // Idempotent by (ref, versionId): re-addressing the same object is a no-op;
      // a conflicting versionId at the same ref is a programming error.
      if (existing.versionId !== options.versionId) {
        throw new CredentialVaultError("credential reference already exists");
      }
      return;
    }
    this.#values.set(secretRef, { bytes: secret.slice(), versionId: options.versionId });
    if (this.#timeoutAfterWrite) {
      this.#timeoutAfterWrite = false;
      throw new CredentialWriteAmbiguousError("local credential vault write timed out");
    }
  }

  public async head(secretRef: string): Promise<CredentialObjectStatus> {
    if (this.#failure === "head") {
      this.#failure = null;
      throw new CredentialWriteAmbiguousError("local credential vault probe unavailable");
    }
    const stored = this.#values.get(secretRef);
    return stored === undefined ? { exists: false } : { exists: true, versionId: stored.versionId };
  }

  public async withCredential<T>(
    secretRef: string,
    use: (secret: Uint8Array) => Promise<T> | T,
  ): Promise<T> {
    this.#throwIfFailed("read");
    const stored = this.#values.get(secretRef);
    if (stored === undefined) {
      throw new CredentialNotFoundError("credential reference was not found");
    }
    const transient = stored.bytes.slice();
    try {
      return await runWithSecret(use, transient);
    } finally {
      transient.fill(0);
    }
  }

  public async revoke(secretRef: string): Promise<void> {
    this.#throwIfFailed("revoke");
    const stored = this.#values.get(secretRef);
    stored?.bytes.fill(0);
    this.#values.delete(secretRef);
  }

  public has(secretRef: string): boolean {
    return this.#values.has(secretRef);
  }

  #throwIfFailed(operation: "read" | "write" | "revoke"): void {
    if (this.#failure === operation) {
      this.#failure = null;
      throw new CredentialVaultUnavailableError(`local credential vault ${operation} failed`);
    }
  }
}

export interface AwsSecretsManagerVaultOptions {
  /** Explicit customer-managed KMS key used for every created secret. */
  kmsKeyId: string;
  /** Namespace prepended to opaque logical refs. */
  secretNamePrefix: string;
  /** Recovery window for revocation/cleanup. */
  recoveryWindowDays?: number;
}

/** AWS Secrets Manager adapter with customer-managed KMS encryption. */
export class AwsSecretsManagerCredentialVault implements CredentialVault {
  readonly #client: SecretsManagerClient;
  readonly #kmsKeyId: string;
  readonly #prefix: string;
  readonly #recoveryWindowDays: number;

  public constructor(client: SecretsManagerClient, options: AwsSecretsManagerVaultOptions) {
    if (options.kmsKeyId.trim() === "" || options.secretNamePrefix.trim() === "") {
      throw new CredentialVaultError("KMS key id and secret name prefix are required");
    }
    this.#client = client;
    this.#kmsKeyId = options.kmsKeyId;
    this.#prefix = options.secretNamePrefix.replace(/\/+$/, "");
    this.#recoveryWindowDays = options.recoveryWindowDays ?? 7;
    if (this.#recoveryWindowDays < 7 || this.#recoveryWindowDays > 30) {
      throw new CredentialVaultError("recoveryWindowDays must be between 7 and 30");
    }
  }

  public async put(
    secretRef: string,
    secret: Uint8Array,
    options: PutCredentialOptions,
  ): Promise<void> {
    const copy = secret.slice();
    try {
      await this.#client.send(
        new CreateSecretCommand({
          Name: this.#name(secretRef),
          KmsKeyId: this.#kmsKeyId,
          SecretBinary: copy,
          ClientRequestToken: options.versionId,
          Tags: [{ Key: "remoteagent-managed", Value: "true" }],
        }),
      );
    } catch (error) {
      // A same-name secret already exists. A same-name+same-token create is
      // idempotent and returns success, so ResourceExistsException means the
      // existing object may be a DIFFERENT version than this intent's. We must
      // NOT assume identity: surface it as ambiguous so the caller reconciles the
      // EXACT version via a value-free probe (AUDIT-02 HIGH-02).
      if (isResourceExists(error)) {
        throw new CredentialWriteAmbiguousError(
          "AWS credential already exists; exact version must be reconciled",
        );
      }
      // A DEFINITE pre-write failure (validation/auth/KMS) never persisted
      // anything, so the caller may safely retry with the same ref.
      if (isDefiniteWriteFailure(error)) {
        throw new CredentialVaultUnavailableError("AWS credential vault write failed");
      }
      // Any other outcome — transport timeout, throttling, 5xx, unknown — may have
      // been accepted by the service after the request left the client. The write
      // outcome is UNKNOWN and must be reconciled, never auto-replayed as a clean
      // failure (AGENTS.md §8; AUDIT-02 HIGH-02).
      throw new CredentialWriteAmbiguousError("AWS credential vault write outcome unknown");
    } finally {
      copy.fill(0);
    }
  }

  public async head(secretRef: string): Promise<CredentialObjectStatus> {
    try {
      const result = await this.#client.send(
        new DescribeSecretCommand({ SecretId: this.#name(secretRef) }),
      );
      // Report the CURRENT version (AWSCURRENT), regardless of key order in the
      // map, so the caller can confirm the exact identity of the stored object.
      const versionId = currentVersionId(result.VersionIdsToStages);
      return versionId === undefined ? { exists: true } : { exists: true, versionId };
    } catch (error) {
      if (isResourceNotFound(error)) {
        return { exists: false };
      }
      // The probe itself is unavailable: existence is unknown, so the write
      // outcome is ambiguous and must not be auto-replayed.
      throw new CredentialWriteAmbiguousError("AWS credential vault probe failed");
    }
  }

  public async withCredential<T>(
    secretRef: string,
    use: (secret: Uint8Array) => Promise<T> | T,
  ): Promise<T> {
    let transient: Uint8Array | undefined;
    try {
      const result = await this.#client.send(
        new GetSecretValueCommand({ SecretId: this.#name(secretRef) }),
      );
      if (result.SecretBinary !== undefined) {
        transient = result.SecretBinary.slice();
      } else if (result.SecretString !== undefined) {
        transient = new TextEncoder().encode(result.SecretString);
      } else {
        throw new CredentialNotFoundError("AWS credential has no secret value");
      }
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultUnavailableError("AWS credential vault read failed");
    }
    try {
      return await runWithSecret(use, transient);
    } finally {
      transient.fill(0);
    }
  }

  public async revoke(secretRef: string): Promise<void> {
    try {
      await this.#client.send(
        new DeleteSecretCommand({
          SecretId: this.#name(secretRef),
          RecoveryWindowInDays: this.#recoveryWindowDays,
        }),
      );
    } catch (error) {
      if (isResourceNotFound(error)) {
        return;
      }
      throw new CredentialVaultUnavailableError("AWS credential vault revoke failed");
    }
  }

  #name(secretRef: string): string {
    const normalized = secretRef.trim();
    if (!/^[A-Za-z0-9/_+=.@-]{1,512}$/.test(normalized) || normalized.includes("..")) {
      throw new CredentialVaultError("invalid credential reference");
    }
    return `${this.#prefix}/${normalized}`;
  }
}

function awsErrorName(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

function isResourceExists(error: unknown): boolean {
  return awsErrorName(error) === "ResourceExistsException";
}

function isResourceNotFound(error: unknown): boolean {
  return awsErrorName(error) === "ResourceNotFoundException";
}

/**
 * Error names that PROVE a CreateSecret never persisted anything: the request was
 * rejected before any write (bad input, missing/incorrect KMS key, denied auth).
 * Only these are treated as definite failures; every other error (timeout,
 * throttling, 5xx, unknown) is ambiguous and must be reconciled, because the
 * service may have accepted the create before the client saw a failure.
 */
const DEFINITE_WRITE_FAILURE_NAMES: ReadonlySet<string> = new Set([
  "ValidationException",
  "InvalidRequestException",
  "InvalidParameterException",
  "MalformedPolicyDocumentException",
  "AccessDeniedException",
  "UnrecognizedClientException",
  "IncompleteSignatureException",
  "EncryptionFailure",
  "DecryptionFailure",
  "ResourceNotFoundException",
]);

function isDefiniteWriteFailure(error: unknown): boolean {
  const name = awsErrorName(error);
  return name !== undefined && DEFINITE_WRITE_FAILURE_NAMES.has(name);
}

/**
 * Resolve the version currently staged as AWSCURRENT, independent of key order in
 * `VersionIdsToStages`. Returning the current version (rather than an arbitrary
 * first key) lets the caller confirm the EXACT identity of the stored secret
 * (AUDIT-02 HIGH-02). When no version carries AWSCURRENT the identity cannot be
 * confirmed, so `undefined` is returned and the caller treats it as a mismatch.
 */
function currentVersionId(
  map: Record<string, string[] | undefined> | undefined,
): string | undefined {
  if (map === undefined) {
    return undefined;
  }
  for (const [versionId, stages] of Object.entries(map)) {
    if (Array.isArray(stages) && stages.includes("AWSCURRENT")) {
      return versionId;
    }
  }
  return undefined;
}
