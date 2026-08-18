/**
 * workflow:validate — deterministic guard for the task workflow.
 *
 * It parses `docs/tasks/TASK_INDEX.md` and verifies that the operational queue
 * stays internally consistent:
 *
 *   - every task id is well formed and unique;
 *   - every table link and task file actually exists;
 *   - every status is a known status;
 *   - every dependency references an existing task;
 *   - the dependency graph has no cycles;
 *   - required handoff/audit artifacts exist for the declared status.
 *
 * The module exports {@link validate} so it can be unit tested against fixture
 * repositories, and runs as a CLI when invoked directly.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ALLOWED_STATUSES = [
  "BLOCKED_BY_DEPENDENCIES",
  "READY",
  "IN_PROGRESS",
  "AWAITING_AUDIT",
  "CHANGES_REQUESTED",
  "AUDIT_PASSED",
  "DONE",
  "BLOCKED",
] as const;

export type TaskStatus = (typeof ALLOWED_STATUSES)[number];

/** Statuses that can only be reached after at least one handoff exists. */
const STATUSES_REQUIRING_HANDOFF = new Set<string>([
  "AWAITING_AUDIT",
  "CHANGES_REQUESTED",
  "AUDIT_PASSED",
  "DONE",
]);

/** Statuses that can only be reached after at least one audit verdict exists. */
const STATUSES_REQUIRING_AUDIT = new Set<string>(["CHANGES_REQUESTED", "AUDIT_PASSED", "DONE"]);

/** The only verdicts an audit document may declare. */
export const AUDIT_VERDICTS = ["PASS", "CHANGES_REQUIRED", "BLOCKED"] as const;
export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];

/**
 * Status -> the verdict the latest audit MUST carry for that status to be legal.
 *
 * These entries are enforced only when the task already has at least one audit
 * artifact (see the `audits > 0` guard in {@link validate}). That audit-presence
 * check is the deterministic provenance distinction for `BLOCKED`:
 *
 *   - **procedural block** — a `BLOCKED` task with NO audit (dependency, owner
 *     Decision Request) carries no verdict obligation and stays legal;
 *   - **audit-driven block** — a `BLOCKED` task that DOES have an audit must have
 *     a latest verdict of `BLOCKED`, so the blocking auditor's decision is bound
 *     to the status.
 *
 * `CHANGES_REQUESTED`, `AUDIT_PASSED` and `DONE` are additionally listed in
 * {@link STATUSES_REQUIRING_AUDIT}, so for them an audit must exist at all.
 */
const STATUS_TO_REQUIRED_VERDICT: Readonly<Record<string, AuditVerdict>> = {
  CHANGES_REQUESTED: "CHANGES_REQUIRED",
  AUDIT_PASSED: "PASS",
  DONE: "PASS",
  BLOCKED: "BLOCKED",
};

const VERDICT_TOKEN_RE = /\b(PASS|CHANGES_REQUIRED|BLOCKED)\b/g;

const TASK_ID_RE = /RA-\d{3}/g;
const STRICT_TASK_ID_RE = /^RA-\d{3}$/;

export interface TaskRow {
  readonly order: number;
  readonly id: string;
  readonly linkTarget: string;
  readonly status: string;
  readonly dependsOn: readonly string[];
  readonly line: number;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly rows: readonly TaskRow[];
}

/** Split a markdown table row into trimmed cells (outer pipes dropped). */
function splitRow(line: string): string[] {
  const cells = line.split("|").map((c) => c.trim());
  // A leading and trailing pipe produce empty first/last entries.
  if (cells.length > 0 && cells[0] === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/** Extract task ids from an arbitrary cell; returns [] for placeholders. */
function extractTaskIds(cell: string): string[] {
  const matches = cell.match(TASK_ID_RE);
  return matches ? [...matches] : [];
}

/**
 * Parse the queue table of TASK_INDEX.md into rows.
 *
 * A data row is any pipe-delimited line whose first cell is an integer order,
 * which excludes the header row and the `---` separator row.
 */
export function parseTaskIndex(content: string): TaskRow[] {
  const rows: TaskRow[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line.startsWith("|")) return;
    const cells = splitRow(line);
    if (cells.length < 4) return;
    const order = Number(cells[0]);
    if (!Number.isInteger(order)) return; // header / separator / non-data row

    const taskCell = cells[1] ?? "";
    const statusCell = cells[2] ?? "";
    const dependsCell = cells[3] ?? "";

    const ids = extractTaskIds(taskCell);
    const id = ids[0] ?? "";
    const linkMatch = taskCell.match(/\]\(([^)]+)\)/);
    const linkTarget = linkMatch?.[1] ?? "";

    rows.push({
      order,
      id,
      linkTarget,
      status: statusCell,
      dependsOn: extractTaskIds(dependsCell),
      line: idx + 1,
    });
  });
  return rows;
}

/** List files matching `<PREFIX>-NN.md` in a directory, tolerating absence. */
function listArtifacts(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${prefix}-\\d{2,}\\.md$`);
  return readdirSync(dir).filter((f) => re.test(f));
}

/** Count files matching `<PREFIX>-NN.md` in a directory, tolerating absence. */
function countArtifacts(dir: string, prefix: string): number {
  return listArtifacts(dir, prefix).length;
}

/** Numeric revision suffix of a `<PREFIX>-NN.md` file name. */
function artifactRevision(name: string): number {
  const m = name.match(/-(\d+)\.md$/);
  return m ? Number(m[1]) : -1;
}

/**
 * Path of the numerically-latest `<PREFIX>-NN.md` in `dir`, or null if none.
 * Sorting is by the numeric revision, not lexicographically, so `-10` beats `-9`.
 */
function latestArtifactPath(dir: string, prefix: string): string | null {
  const files = listArtifacts(dir, prefix);
  if (files.length === 0) return null;
  let best = files[0] as string;
  for (const f of files) {
    if (artifactRevision(f) > artifactRevision(best)) best = f;
  }
  return join(dir, best);
}

export type VerdictParse =
  | { readonly kind: "ok"; readonly verdict: AuditVerdict }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous"; readonly found: readonly string[] };

const VERDICT_DECLARATION_RE = /^\s*[-*]?\s*Werdykt\s*[:：]/i;

/**
 * Extract the single declared verdict from an audit document.
 *
 * A well-formed audit carries EXACTLY ONE declaration line `- Werdykt: \`PASS\``
 * with EXACTLY ONE verdict token after the colon. Everything else is rejected so
 * the audit gate cannot be bypassed by a malformed or conflicting document:
 *
 *   - zero declaration lines, or a declaration with no token -> `missing`;
 *   - more than one declaration line (two `Werdykt:` lines) -> `ambiguous`;
 *   - more than one token on the declaration line -> `ambiguous`. This covers
 *     both the unfilled template `PASS | CHANGES_REQUIRED | BLOCKED` and a
 *     repeated token such as `PASS PASS` (raw occurrences are counted, not
 *     de-duplicated).
 *
 * The whole document is scanned, not just the first matching line.
 */
export function parseAuditVerdict(content: string): VerdictParse {
  const declarations = content.split(/\r?\n/).filter((raw) => VERDICT_DECLARATION_RE.test(raw));
  if (declarations.length === 0) return { kind: "missing" };
  if (declarations.length > 1) {
    const found = declarations.flatMap((l) => l.match(VERDICT_TOKEN_RE) ?? []);
    return { kind: "ambiguous", found };
  }

  const after = (declarations[0] as string).replace(VERDICT_DECLARATION_RE, "");
  const tokens = after.match(VERDICT_TOKEN_RE) ?? [];
  if (tokens.length === 0) return { kind: "missing" };
  if (tokens.length > 1) return { kind: "ambiguous", found: tokens };
  return { kind: "ok", verdict: tokens[0] as AuditVerdict };
}

/** Detect any cycle in the dependency graph; returns one cycle path or null. */
function findCycle(rows: readonly TaskRow[]): string[] | null {
  const graph = new Map<string, readonly string[]>();
  for (const r of rows) graph.set(r.id, r.dependsOn);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (!graph.has(dep)) continue; // missing deps reported elsewhere
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        const start = stack.indexOf(dep);
        return [...stack.slice(start), dep];
      }
      if (c === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const r of rows) {
    if ((color.get(r.id) ?? WHITE) === WHITE) {
      const cycle = visit(r.id);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * Validate the workflow state rooted at `repoRoot`.
 *
 * Pure with respect to the filesystem it reads; it never mutates anything and
 * returns every problem found so callers can print all of them at once.
 */
export function validate(repoRoot: string): ValidationResult {
  const errors: string[] = [];
  const tasksDir = join(repoRoot, "docs", "tasks");
  const indexPath = join(tasksDir, "TASK_INDEX.md");

  if (!existsSync(indexPath)) {
    return { ok: false, errors: [`missing task index: ${indexPath}`], rows: [] };
  }

  const rows = parseTaskIndex(readFileSync(indexPath, "utf8"));
  if (rows.length === 0) {
    errors.push("task index contains no parseable task rows");
  }

  const seen = new Set<string>();
  for (const row of rows) {
    const where = `TASK_INDEX.md:${row.line}`;

    if (!STRICT_TASK_ID_RE.test(row.id)) {
      errors.push(`${where}: malformed or missing task id in row "${row.id || "?"}"`);
      continue;
    }
    if (seen.has(row.id)) {
      errors.push(`${where}: duplicate task id ${row.id}`);
    }
    seen.add(row.id);

    if (!ALLOWED_STATUSES.includes(row.status as TaskStatus)) {
      errors.push(`${where}: ${row.id} has invalid status "${row.status}"`);
    }

    if (row.linkTarget !== `${row.id}.md`) {
      errors.push(`${where}: ${row.id} link target "${row.linkTarget}" should be "${row.id}.md"`);
    }
    if (!existsSync(join(tasksDir, `${row.id}.md`))) {
      errors.push(`${where}: ${row.id} has no task file docs/tasks/${row.id}.md`);
    }

    const auditsDir = join(repoRoot, "docs", "audits", row.id);
    const handoffs = countArtifacts(join(repoRoot, "docs", "handoffs", row.id), "HANDOFF");
    const audits = countArtifacts(auditsDir, "AUDIT");
    if (STATUSES_REQUIRING_HANDOFF.has(row.status) && handoffs === 0) {
      errors.push(
        `${where}: ${row.id} is ${row.status} but has no handoff in docs/handoffs/${row.id}/`,
      );
    }
    if (STATUSES_REQUIRING_AUDIT.has(row.status) && audits === 0) {
      errors.push(
        `${where}: ${row.id} is ${row.status} but has no audit in docs/audits/${row.id}/`,
      );
    }

    // Status reachable only by an auditor must match the latest audit verdict.
    const requiredVerdict = STATUS_TO_REQUIRED_VERDICT[row.status];
    if (requiredVerdict !== undefined && audits > 0) {
      const latest = latestArtifactPath(auditsDir, "AUDIT");
      // `latest` is non-null because audits > 0.
      const parsed = parseAuditVerdict(readFileSync(latest as string, "utf8"));
      const rel = `docs/audits/${row.id}/${(latest as string).split("/").pop() ?? ""}`;
      if (parsed.kind === "missing") {
        errors.push(`${where}: ${row.id} latest audit ${rel} declares no verdict`);
      } else if (parsed.kind === "ambiguous") {
        errors.push(
          `${where}: ${row.id} latest audit ${rel} has an ambiguous verdict (${parsed.found.join(", ")}); fill in the template`,
        );
      } else if (parsed.verdict !== requiredVerdict) {
        errors.push(
          `${where}: ${row.id} is ${row.status} but latest audit ${rel} verdict is ${parsed.verdict} (expected ${requiredVerdict})`,
        );
      }
    }
  }

  for (const row of rows) {
    for (const dep of row.dependsOn) {
      if (!seen.has(dep)) {
        errors.push(`TASK_INDEX.md:${row.line}: ${row.id} depends on unknown task ${dep}`);
      }
    }
  }

  const cycle = findCycle(rows);
  if (cycle) {
    errors.push(`dependency cycle detected: ${cycle.join(" -> ")}`);
  }

  return { ok: errors.length === 0, errors, rows };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  const repoRoot = process.argv[2]
    ? process.argv[2]
    : join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
  const result = validate(repoRoot);
  if (result.ok) {
    process.stdout.write(`workflow:validate OK — ${result.rows.length} tasks\n`);
  } else {
    process.stderr.write(`workflow:validate FAILED (${result.errors.length} error(s)):\n`);
    for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
}
