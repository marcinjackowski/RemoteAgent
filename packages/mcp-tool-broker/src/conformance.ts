/**
 * Conformance: comparing what a remote server ADVERTISES against what the registry
 * DEFINES (AC3).
 *
 * The central claim of this module is that `tools/list` is data, not authority. It is
 * worth being precise about what that buys, because a weaker reading of AC3 —
 * "sanitize remote descriptions before showing them to the model" — sounds
 * equivalent and is not. Sanitizing implies the remote text reaches a prompt in some
 * form, so its safety depends on the filter being complete. Here the remote
 * description reaches no prompt at all: {@link ToolManifest} carries the
 * server-authored description, and the remote one is retained only so that this
 * module can compare and report. A prompt-injection payload in a remote description
 * is therefore inert by construction rather than by filtration, and
 * {@link detectInjectionMarkers} exists to raise an ALERT about a hostile server, not
 * to make its text safe.
 *
 * Schema drift is the other half. A server may advertise a schema that differs from
 * the registered one — extra required fields, a renamed scope parameter, a widened
 * type. None of it changes what the broker sends (arguments are validated against the
 * REGISTERED schema and only the parsed result is forwarded), so drift cannot widen
 * scope. But it does mean the far side may interpret a call differently than
 * intended, which for a scoped read is a potential cross-scope read — so drift is a
 * refusal (`SCHEMA_DRIFT`), reported per tool, rather than a warning.
 *
 * What this module deliberately does NOT do: reconcile, merge, or update the registry
 * from an advertisement. There is no code path by which a remote server changes local
 * policy. That absence is the AC3 guarantee.
 */
import * as z from "zod";

import {
  RefusalCode,
  ToolBrokerRefusal,
  remoteToolAdvertisement,
  type RemoteToolAdvertisement,
  type ToolDescriptor,
} from "./contracts.js";

/**
 * Phrases that indicate a remote description is attempting to instruct the agent
 * rather than describe a tool.
 *
 * This list is a DETECTOR, not a filter, and the distinction is load-bearing: safety
 * does not depend on it being complete, because no remote description is ever placed
 * in a prompt. A denylist would be the wrong shape for a security boundary
 * (`CTF-010` finding 2) — here it is the right shape for a signal, since its job is
 * to tell an operator "this server is hostile", and a missed phrase costs an alert,
 * not a compromise.
 */
const INJECTION_MARKERS: readonly RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /you\s+are\s+now\s+/i,
  /system\s*prompt/i,
  /\bnew\s+(instructions|rules|policy)\b/i,
  /you\s+(may|can|are\s+allowed\s+to)\s+now\s+(write|delete|push|merge|send)/i,
  /grant(ed)?\s+(full|admin|elevated)\s+(access|permission)/i,
  /\bapproved\s+by\s+(the\s+)?(owner|user|admin)\b/i,
  /<\s*\/?\s*(system|instructions?|policy)\s*>/i,
  /\bBEGIN\s+SYSTEM\b/i,
];

/** A marker found in remote-supplied text, with where it was found. */
export type InjectionFinding = Readonly<{
  field: "description" | "schema";
  pattern: string;
}>;

/**
 * Scan remote-supplied text for instruction-shaped content.
 *
 * Returns findings; raises nothing. The caller decides, and for a read-only tool the
 * decision is "refuse this server's tool and tell the operator" rather than "strip
 * the phrase and continue".
 */
export function detectInjectionMarkers(
  advertisement: RemoteToolAdvertisement,
): readonly InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const pattern of INJECTION_MARKERS) {
    if (pattern.test(advertisement.description)) {
      findings.push({ field: "description", pattern: pattern.source });
    }
  }
  // A schema is a common second channel: `description` fields nested inside a JSON
  // Schema are shown verbatim by many MCP clients.
  const schemaText = JSON.stringify(advertisement.input_schema);
  for (const pattern of INJECTION_MARKERS) {
    if (pattern.test(schemaText)) {
      findings.push({ field: "schema", pattern: pattern.source });
    }
  }
  return findings;
}

export const ConformanceVerdict = {
  /** Advertisement matches the registered descriptor closely enough to call. */
  CONFORMS: "CONFORMS",
  /** Advertised schema diverges from the registered one. Not callable. */
  SCHEMA_DRIFT: "SCHEMA_DRIFT",
  /** The server advertises a tool the registry does not define. Ignored. */
  UNKNOWN_TO_REGISTRY: "UNKNOWN_TO_REGISTRY",
  /** The advertisement is not a well-formed `tools/list` entry. */
  MALFORMED: "MALFORMED",
} as const;

export type ConformanceVerdict = (typeof ConformanceVerdict)[keyof typeof ConformanceVerdict];

export type ToolConformanceReport = Readonly<{
  toolName: string;
  verdict: ConformanceVerdict;
  /** Instruction-shaped content found in remote text. Inert, but reported. */
  injectionFindings: readonly InjectionFinding[];
  /** Human-readable divergence detail, for an operator. Never for a prompt. */
  detail: string | null;
}>;

/** Shape of a raw `tools/list` entry before it is trusted to be even well-formed. */
const rawAdvertisement = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Parse a raw `tools/list` entry into a trust-marked advertisement.
 *
 * Returns null for anything malformed rather than throwing: one bad entry in a list
 * must not prevent the rest from being examined, and a server that sends garbage
 * should be reported per-tool, not as a total failure to introspect.
 */
export function parseAdvertisement(raw: unknown): RemoteToolAdvertisement | null {
  const parsed = rawAdvertisement.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data;
  const advertisement = remoteToolAdvertisement.safeParse({
    trust: "UNTRUSTED_DATA",
    name: value.name,
    // Bounded here: `text` caps at 64 KiB, so a 40 MB description cannot be held.
    description: (value.description ?? "").slice(0, 65_536),
    input_schema: value.inputSchema ?? value.input_schema ?? {},
  });
  return advertisement.success ? advertisement.data : null;
}

/**
 * Compare one advertisement against the registered descriptor.
 *
 * The comparison is on the ARGUMENT NAMES the server requires, not on full JSON
 * Schema equality. Full equality would be both too strict (servers legitimately add
 * annotations, titles and examples) and beside the point: what matters is whether the
 * far side expects a different set of inputs than the broker will send, because that
 * is the condition under which a scoped read means something else remotely.
 *
 * A server requiring an argument the registry does not define is drift. A server
 * omitting one the registry defines is drift too — it will silently ignore the scope
 * argument the broker injects, which is precisely how a "read issue in project MOBL"
 * becomes "read issue in whatever project the server defaults to".
 */
export function checkToolConformance(
  descriptor: ToolDescriptor,
  advertisement: RemoteToolAdvertisement,
): ToolConformanceReport {
  const injectionFindings = detectInjectionMarkers(advertisement);
  const registeredKeys = new Set(registeredArgumentNames(descriptor));
  const advertised = advertisedArgumentNames(advertisement.input_schema);

  if (advertised === null) {
    return {
      toolName: descriptor.name,
      verdict: ConformanceVerdict.MALFORMED,
      injectionFindings,
      detail: "advertised input schema is not an object schema with properties",
    };
  }

  const advertisedRequired = new Set(advertised.required);
  const unexpectedRequired = [...advertisedRequired].filter((key) => !registeredKeys.has(key));
  const missing = [...registeredKeys].filter((key) => !advertised.all.includes(key));

  if (unexpectedRequired.length > 0 || missing.length > 0) {
    return {
      toolName: descriptor.name,
      verdict: ConformanceVerdict.SCHEMA_DRIFT,
      injectionFindings,
      detail:
        `advertised schema diverges: unexpected required [${unexpectedRequired.join(", ")}], ` +
        `absent [${missing.join(", ")}]`,
    };
  }

  return {
    toolName: descriptor.name,
    verdict: ConformanceVerdict.CONFORMS,
    injectionFindings,
    detail: null,
  };
}

/**
 * Argument names the broker will send: the descriptor's own keys plus the
 * server-injected scope argument.
 *
 * The injected name must be included or every conforming server would look like
 * drift — the broker sends `project_id` even though no descriptor declares it (the
 * forbidden-name gate forbids declaring it).
 */
function registeredArgumentNames(descriptor: ToolDescriptor): readonly string[] {
  const def = (descriptor.arguments_schema as { def?: { shape?: Record<string, unknown> } }).def;
  const declared = def?.shape === undefined ? [] : Object.keys(def.shape);
  return [...declared, scopeArgumentNameFor(descriptor.scope.scope_kind)];
}

function scopeArgumentNameFor(kind: string): string {
  switch (kind) {
    case "project":
      return "project_id";
    case "repository":
      return "repository_id";
    case "calendar":
      return "calendar_id";
    case "account":
      return "account_id";
    default:
      return kind;
  }
}

function advertisedArgumentNames(
  schema: Readonly<Record<string, unknown>>,
): { all: readonly string[]; required: readonly string[] } | null {
  const properties = schema["properties"];
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return null;
  }
  const rawRequired = schema["required"];
  const required = Array.isArray(rawRequired)
    ? rawRequired.filter((item): item is string => typeof item === "string")
    : [];
  return { all: Object.keys(properties as Record<string, unknown>), required };
}

/**
 * Check an entire `tools/list` response.
 *
 * Every entry gets a verdict, including ones the registry does not know — a server
 * advertising `jira.delete_project` is not an error, it is simply not callable, and
 * recording that is how an operator notices a server offering more than it should.
 * Unknown tools are never added to the registry.
 */
export function checkListConformance(
  descriptors: readonly ToolDescriptor[],
  rawList: readonly unknown[],
): readonly ToolConformanceReport[] {
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  const reports: ToolConformanceReport[] = [];
  for (const raw of rawList) {
    const advertisement = parseAdvertisement(raw);
    if (advertisement === null) {
      reports.push({
        toolName:
          typeof (raw as { name?: unknown })?.name === "string"
            ? String((raw as { name: string }).name).slice(0, 512)
            : "<unparseable>",
        verdict: ConformanceVerdict.MALFORMED,
        injectionFindings: [],
        detail: "advertisement is not a well-formed tools/list entry",
      });
      continue;
    }
    const descriptor = byName.get(advertisement.name);
    if (descriptor === undefined) {
      reports.push({
        toolName: advertisement.name,
        verdict: ConformanceVerdict.UNKNOWN_TO_REGISTRY,
        injectionFindings: detectInjectionMarkers(advertisement),
        detail: "server advertises a tool the registry does not define; it is not callable",
      });
      continue;
    }
    reports.push(checkToolConformance(descriptor, advertisement));
  }
  return reports;
}

/**
 * Refuse unless the named tool conforms.
 *
 * Called before a remote tool is used. Injection findings alone do NOT block the
 * call — the remote text is inert, and refusing on a phrase match would let any
 * server disable its own tools by including a marker, while also making the gate
 * depend on the completeness of a denylist. Drift and malformation DO block, because
 * those bear on whether the call means what we intend.
 */
export function assertToolConforms(
  reports: readonly ToolConformanceReport[],
  toolName: string,
): void {
  const report = reports.find((candidate) => candidate.toolName === toolName);
  if (report === undefined) {
    throw new ToolBrokerRefusal(
      RefusalCode.SCHEMA_DRIFT,
      `server does not advertise ${toolName}; refusing to call an unadvertised tool`,
    );
  }
  if (report.verdict === ConformanceVerdict.SCHEMA_DRIFT) {
    throw new ToolBrokerRefusal(
      RefusalCode.SCHEMA_DRIFT,
      `${toolName}: ${report.detail ?? "advertised schema diverges from the registry"}`,
    );
  }
  if (report.verdict === ConformanceVerdict.MALFORMED) {
    throw new ToolBrokerRefusal(
      RefusalCode.PROTOCOL_VIOLATION,
      `${toolName}: ${report.detail ?? "advertisement is malformed"}`,
    );
  }
  if (report.verdict === ConformanceVerdict.UNKNOWN_TO_REGISTRY) {
    throw new ToolBrokerRefusal(
      RefusalCode.UNKNOWN_TOOL,
      `${toolName} is not defined by the server-owned registry`,
    );
  }
}
