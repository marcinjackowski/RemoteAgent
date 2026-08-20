import {
  assertAnswerMatchesRequest,
  decisionAnswer,
  decisionRequest,
  idString,
  isoTimestamp,
  sha256Digest,
  text,
  type DecisionAnswer,
  type DecisionRequest,
} from "@remoteagent/contracts";
import { canonicalJson, canonicalSha256 } from "./digest.js";

export const PlanningAmbiguityClass = {
  REQUIREMENT_CONFLICT: "REQUIREMENT_CONFLICT",
  SCOPE_UNCLEAR: "SCOPE_UNCLEAR",
  SECURITY_POLICY_REQUIRED: "SECURITY_POLICY_REQUIRED",
  IRREVERSIBLE_TRADEOFF: "IRREVERSIBLE_TRADEOFF",
} as const;

export type PlanningAmbiguityClass =
  (typeof PlanningAmbiguityClass)[keyof typeof PlanningAmbiguityClass];

export type PlanningDecisionAuthority = Readonly<{
  caseId: string;
  checkpointRevision: number;
  profileId: string;
  profileDigest: string;
  requirementId: string;
}>;

export type PlanningDecisionProposal = Readonly<{
  class: PlanningAmbiguityClass;
  question: string;
  whyNow: string;
  options: readonly Readonly<{ id: string; label: string; consequences: string }>[];
  recommendation: string;
  blockedScope: string;
  expiresAt?: string;
}>;

export type PlanningDecisionBinding = Readonly<
  PlanningDecisionAuthority & {
    ambiguityClass: PlanningAmbiguityClass;
    requestDigest: string;
    bindingDigest: string;
  }
>;

export type PlanningDecisionResult = Readonly<{
  request: DecisionRequest;
  binding: PlanningDecisionBinding;
}>;

export type PlanningDecisionSelection = Readonly<{
  decisionId: string;
  selectedOptionId: string;
  bindingDigest: string;
}>;

export type PlanningDecisionErrorCode =
  "INVALID_INPUT" | "UNKNOWN_CLASS" | "UNSAFE_DATA" | "STALE" | "MISMATCH" | "UNKNOWN_OPTION";

export class PlanningDecisionError extends Error {
  public constructor(
    public readonly code: PlanningDecisionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlanningDecisionError";
  }
}

function fail(code: PlanningDecisionErrorCode, message: string): never {
  throw new PlanningDecisionError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label = "Decision proposal",
): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    fail("INVALID_INPUT", `${label} contains an unauthorized field`);
}

function safeText(value: unknown, label: string): string {
  if (typeof value !== "string") fail("INVALID_INPUT", `Invalid decision ${label}`);
  try {
    text.parse(value);
  } catch {
    fail("INVALID_INPUT", `Invalid decision ${label}`);
  }
  if (
    /(?:^|[\s"'=])(?:\/Users\/|\/home\/|\/tmp\/|\/private\/|[A-Za-z]:[\\/]|file:\/\/)/iu.test(
      value,
    ) ||
    /-----BEGIN [^-]*PRIVATE KEY-----/u.test(value) ||
    /(?:password|secret|token|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s]/iu.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~-]{8,}/u.test(value) ||
    /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(value) ||
    /\b(?:glpat-|gh[pousr]_|AKIA)[A-Za-z0-9_-]{8,}/u.test(value)
  )
    fail("UNSAFE_DATA", "Decision contains unsafe data");
  return value;
}

function parseAuthority(value: unknown): PlanningDecisionAuthority {
  if (!isRecord(value)) fail("INVALID_INPUT", "Invalid decision authority");
  onlyKeys(
    value,
    ["caseId", "checkpointRevision", "profileId", "profileDigest", "requirementId"],
    "Decision authority",
  );
  try {
    idString.parse(value.caseId);
    idString.parse(value.profileId);
    idString.parse(value.requirementId);
    sha256Digest.parse(value.profileDigest);
    if (
      !Number.isSafeInteger(value.checkpointRevision as number) ||
      (value.checkpointRevision as number) < 0
    )
      throw new Error("revision");
  } catch {
    fail("INVALID_INPUT", "Invalid decision authority");
  }
  return {
    caseId: value.caseId as string,
    checkpointRevision: value.checkpointRevision as number,
    profileId: value.profileId as string,
    profileDigest: value.profileDigest as string,
    requirementId: value.requirementId as string,
  };
}

function parseBinding(value: unknown): PlanningDecisionBinding {
  if (!isRecord(value)) fail("INVALID_INPUT", "Invalid decision binding");
  onlyKeys(
    value,
    [
      "caseId",
      "checkpointRevision",
      "profileId",
      "profileDigest",
      "requirementId",
      "ambiguityClass",
      "requestDigest",
      "bindingDigest",
    ],
    "Decision binding",
  );
  const authority = parseAuthority({
    caseId: value.caseId,
    checkpointRevision: value.checkpointRevision,
    profileId: value.profileId,
    profileDigest: value.profileDigest,
    requirementId: value.requirementId,
  });
  if (
    !Object.values(PlanningAmbiguityClass).includes(value.ambiguityClass as PlanningAmbiguityClass)
  )
    fail("UNKNOWN_CLASS", "Unknown material ambiguity class");
  try {
    sha256Digest.parse(value.requestDigest);
    sha256Digest.parse(value.bindingDigest);
  } catch {
    fail("INVALID_INPUT", "Invalid decision binding digest");
  }
  return {
    ...authority,
    ambiguityClass: value.ambiguityClass as PlanningAmbiguityClass,
    requestDigest: value.requestDigest as string,
    bindingDigest: value.bindingDigest as string,
  };
}

function parseProposal(value: unknown): PlanningDecisionProposal {
  if (!isRecord(value)) fail("INVALID_INPUT", "Decision proposal must be an object");
  onlyKeys(value, [
    "class",
    "question",
    "whyNow",
    "options",
    "recommendation",
    "blockedScope",
    "expiresAt",
  ]);
  if (!Object.values(PlanningAmbiguityClass).includes(value.class as PlanningAmbiguityClass))
    fail("UNKNOWN_CLASS", "Unknown material ambiguity class");
  const options = value.options;
  if (!Array.isArray(options) || options.length < 2 || options.length > 3)
    fail("INVALID_INPUT", "Decision requires two or three options");
  const parsedOptions = options.map((option) => {
    if (!isRecord(option)) fail("INVALID_INPUT", "Invalid decision option");
    onlyKeys(option, ["id", "label", "consequences"]);
    try {
      idString.parse(option.id);
    } catch {
      fail("INVALID_INPUT", "Invalid decision option");
    }
    safeText(option.id, "option ID");
    return {
      id: option.id as string,
      label: safeText(option.label, "option label"),
      consequences: safeText(option.consequences, "option consequences"),
    };
  });
  if (new Set(parsedOptions.map((option) => option.id)).size !== parsedOptions.length)
    fail("INVALID_INPUT", "Decision option IDs must be unique");
  parsedOptions.sort((a, b) =>
    Buffer.from(canonicalJson(a), "utf8").compare(Buffer.from(canonicalJson(b), "utf8")),
  );
  const recommendation = safeText(value.recommendation, "recommendation");
  if (!parsedOptions.some((option) => option.id === recommendation))
    fail("INVALID_INPUT", "Recommendation must select an option");
  let expiresAt: string | undefined;
  if (value.expiresAt !== undefined) {
    expiresAt = safeText(value.expiresAt, "expiry");
    try {
      isoTimestamp.parse(expiresAt);
    } catch {
      fail("INVALID_INPUT", "Invalid decision expiry");
    }
  }
  return {
    class: value.class as PlanningAmbiguityClass,
    question: safeText(value.question, "question"),
    whyNow: safeText(value.whyNow, "whyNow"),
    options: parsedOptions,
    recommendation,
    blockedScope: safeText(value.blockedScope, "blockedScope"),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function bindingDigest(
  authority: PlanningDecisionAuthority,
  ambiguityClass: PlanningAmbiguityClass,
  requestDigest: string,
): string {
  return canonicalSha256({
    caseId: authority.caseId,
    checkpointRevision: authority.checkpointRevision,
    profileId: authority.profileId,
    profileDigest: authority.profileDigest,
    requirementId: authority.requirementId,
    ambiguityClass,
    requestDigest,
  });
}

function requestContent(request: {
  case_id: string;
  question: string;
  why_now: string;
  options: readonly Readonly<{ id: string; label: string; consequences: string }>[];
  recommendation: string;
  blocked_scope: string;
  checkpoint_revision: number;
  expires_at?: string | undefined;
}): Record<string, unknown> {
  return {
    case_id: request.case_id,
    question: request.question,
    why_now: request.why_now,
    options: request.options,
    recommendation: request.recommendation,
    blocked_scope: request.blocked_scope,
    checkpoint_revision: request.checkpoint_revision,
    ...(request.expires_at === undefined ? {} : { expires_at: request.expires_at }),
  };
}

function requestDigest(request: DecisionRequest): string {
  return canonicalSha256(requestContent(request));
}

function decisionId(request: DecisionRequest, binding: PlanningDecisionBinding): string {
  const proposal = {
    class: binding.ambiguityClass,
    question: request.question,
    whyNow: request.why_now,
    options: request.options,
    recommendation: request.recommendation,
    blockedScope: request.blocked_scope,
    ...(request.expires_at === undefined ? {} : { expiresAt: request.expires_at }),
  };
  return `decision_${canonicalSha256({ binding, proposal }).slice("sha256:".length)}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function createPlanningDecision(
  authorityInput: PlanningDecisionAuthority,
  proposalInput: unknown,
): PlanningDecisionResult {
  const authority = parseAuthority(authorityInput);
  const proposal = parseProposal(proposalInput);
  const requestFields = requestContent({
    case_id: authority.caseId,
    question: proposal.question,
    why_now: proposal.whyNow,
    options: proposal.options,
    recommendation: proposal.recommendation,
    blocked_scope: proposal.blockedScope,
    checkpoint_revision: authority.checkpointRevision,
    ...(proposal.expiresAt === undefined ? {} : { expires_at: proposal.expiresAt }),
  });
  const contentDigest = canonicalSha256(requestFields);
  const digest = bindingDigest(authority, proposal.class, contentDigest);
  const fullBinding = {
    ...authority,
    ambiguityClass: proposal.class,
    requestDigest: contentDigest,
    bindingDigest: digest,
  };
  const decisionId = `decision_${canonicalSha256({ binding: fullBinding, proposal }).slice("sha256:".length)}`;
  let request: DecisionRequest;
  try {
    request = decisionRequest.parse({
      schema_version: 1,
      decision_id: decisionId,
      case_id: authority.caseId,
      question: proposal.question,
      why_now: proposal.whyNow,
      options: proposal.options,
      recommendation: proposal.recommendation,
      blocked_scope: proposal.blockedScope,
      checkpoint_revision: authority.checkpointRevision,
      ...(proposal.expiresAt === undefined ? {} : { expires_at: proposal.expiresAt }),
    });
  } catch {
    fail("INVALID_INPUT", "Decision request does not satisfy its contract");
  }
  return deepFreeze({ request, binding: deepFreeze(fullBinding) });
}

function exactAuthority(
  expected: PlanningDecisionAuthority,
  actual: PlanningDecisionAuthority,
): void {
  if (
    expected.caseId !== actual.caseId ||
    expected.checkpointRevision !== actual.checkpointRevision ||
    expected.profileId !== actual.profileId ||
    expected.profileDigest !== actual.profileDigest ||
    expected.requirementId !== actual.requirementId
  )
    fail("STALE", "Decision authority is no longer current");
}

export function validatePlanningDecisionAnswer(
  request: DecisionRequest,
  binding: PlanningDecisionBinding,
  answerInput: unknown,
  currentAuthorityInput: PlanningDecisionAuthority,
): PlanningDecisionSelection {
  let parsedRequest: DecisionRequest;
  try {
    parsedRequest = decisionRequest.parse(request);
  } catch {
    fail("INVALID_INPUT", "Invalid decision request");
  }
  const parsedBinding = parseBinding(binding);
  let answer: DecisionAnswer;
  try {
    answer = decisionAnswer.parse(answerInput);
  } catch {
    fail("INVALID_INPUT", "Invalid decision answer");
  }
  const currentAuthority = parseAuthority(currentAuthorityInput);
  exactAuthority(parsedBinding, currentAuthority);
  if (
    parsedRequest.case_id !== parsedBinding.caseId ||
    parsedRequest.checkpoint_revision !== parsedBinding.checkpointRevision
  )
    fail("MISMATCH", "Decision request authority does not match its binding");
  const actualRequestDigest = requestDigest(parsedRequest);
  if (parsedBinding.requestDigest !== actualRequestDigest)
    fail("MISMATCH", "Decision request content does not match its binding");
  if (
    parsedBinding.bindingDigest !==
    bindingDigest(parsedBinding, parsedBinding.ambiguityClass, actualRequestDigest)
  )
    fail("MISMATCH", "Decision binding digest is invalid");
  if (parsedRequest.decision_id !== decisionId(parsedRequest, parsedBinding))
    fail("MISMATCH", "Decision request identity does not match its binding");
  try {
    assertAnswerMatchesRequest(parsedRequest, answer);
  } catch (error) {
    if (error instanceof Error && error.name === "StaleDecisionAnswerError")
      fail("STALE", "Decision answer is stale");
    if (error instanceof Error && error.name === "UnknownDecisionOptionError")
      fail("UNKNOWN_OPTION", "Decision answer selected an unavailable option");
    fail("MISMATCH", "Decision answer does not match the request");
  }
  if (answer.note !== undefined) safeText(answer.note, "answer note");
  return deepFreeze({
    decisionId: answer.decision_id,
    selectedOptionId: answer.selected_option_id,
    bindingDigest: parsedBinding.bindingDigest,
  });
}
