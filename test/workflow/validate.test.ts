import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseAuditVerdict, parseTaskIndex, validate } from "../../scripts/workflow/validate.ts";

const roots: string[] = [];

afterEach(() => {
  // Remove every fixture repo so repeated runs stay hermetic.
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

interface RowSpec {
  order: number;
  id: string;
  linkTarget?: string;
  status: string;
  dependsOn?: string[];
}

interface AuditSpec {
  id: string;
  /** Revision number -> AUDIT-<NN>.md. Defaults to 1. */
  rev?: number;
  /** Declared verdict; ignored when `raw` is set. Defaults to "PASS". */
  verdict?: string;
  /** Raw file body, bypassing the verdict template (for malformed cases). */
  raw?: string;
}

interface RepoSpec {
  rows: RowSpec[];
  /** Task ids for which a docs/tasks/<id>.md file should be created. */
  taskFiles?: string[];
  /** Task ids that should get a handoff file. */
  handoffs?: string[];
  /** Audits to create; a bare string means a single PASS audit for that id. */
  audits?: Array<string | AuditSpec>;
}

function buildRepo(spec: RepoSpec): string {
  const root = mkdtempSync(join(tmpdir(), "ra-wf-"));
  roots.push(root);
  const tasksDir = join(root, "docs", "tasks");
  mkdirSync(tasksDir, { recursive: true });

  const header = [
    "# Task Index",
    "",
    "## Queue",
    "",
    "| Order | Task | Status | Depends on | Milestone |",
    "|---:|---|---|---|---|",
  ];
  const body = spec.rows.map((r) => {
    const link = r.linkTarget ?? `${r.id}.md`;
    const deps = r.dependsOn && r.dependsOn.length > 0 ? r.dependsOn.join(", ") : "—";
    return `| ${r.order} | [${r.id}](${link}) Title | ${r.status} | ${deps} | M0 |`;
  });
  writeFileSync(join(tasksDir, "TASK_INDEX.md"), [...header, ...body, ""].join("\n"));

  const taskFiles = spec.taskFiles ?? spec.rows.map((r) => r.id);
  for (const id of taskFiles) writeFileSync(join(tasksDir, `${id}.md`), `# ${id}\n`);

  for (const id of spec.handoffs ?? []) {
    const dir = join(root, "docs", "handoffs", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "HANDOFF-01.md"), `# ${id} handoff\n`);
  }
  for (const entry of spec.audits ?? []) {
    const audit: AuditSpec = typeof entry === "string" ? { id: entry } : entry;
    const dir = join(root, "docs", "audits", audit.id);
    mkdirSync(dir, { recursive: true });
    const nn = String(audit.rev ?? 1).padStart(2, "0");
    const body = audit.raw ?? `# ${audit.id} audit\n\n- Werdykt: \`${audit.verdict ?? "PASS"}\`\n`;
    writeFileSync(join(dir, `AUDIT-${nn}.md`), body);
  }
  return root;
}

describe("parseTaskIndex", () => {
  it("parses order, id, link target, status and dependencies", () => {
    const rows = parseTaskIndex(
      [
        "| Order | Task | Status | Depends on | Milestone |",
        "|---:|---|---|---|---|",
        "| 1 | [RA-001](RA-001.md) Foundation | READY | — | M0 |",
        "| 2 | [RA-002](RA-002.md) Next | BLOCKED_BY_DEPENDENCIES | RA-001 | M0 |",
      ].join("\n"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ order: 1, id: "RA-001", status: "READY", dependsOn: [] });
    expect(rows[1]).toMatchObject({
      id: "RA-002",
      linkTarget: "RA-002.md",
      dependsOn: ["RA-001"],
    });
  });

  it("ignores the header and separator rows", () => {
    const rows = parseTaskIndex("| Order | Task |\n|---|---|\n");
    expect(rows).toHaveLength(0);
  });
});

describe("validate — positive path", () => {
  it("accepts a consistent queue", () => {
    const root = buildRepo({
      rows: [
        { order: 1, id: "RA-001", status: "READY" },
        { order: 2, id: "RA-002", status: "BLOCKED_BY_DEPENDENCIES", dependsOn: ["RA-001"] },
      ],
    });
    const result = validate(root);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts artifact-bearing statuses when the files exist", () => {
    const root = buildRepo({
      rows: [
        { order: 1, id: "RA-001", status: "DONE" },
        { order: 2, id: "RA-002", status: "AWAITING_AUDIT", dependsOn: ["RA-001"] },
      ],
      handoffs: ["RA-001", "RA-002"],
      audits: ["RA-001"],
    });
    expect(validate(root).ok).toBe(true);
  });
});

describe("validate — negative path", () => {
  it("flags an invalid status", () => {
    const root = buildRepo({ rows: [{ order: 1, id: "RA-001", status: "SHIPPED" }] });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('invalid status "SHIPPED"'))).toBe(true);
  });

  it("flags a missing task file", () => {
    const root = buildRepo({
      rows: [
        { order: 1, id: "RA-001", status: "READY" },
        { order: 2, id: "RA-002", status: "READY" },
      ],
      taskFiles: ["RA-001"], // RA-002.md deliberately absent
    });
    const result = validate(root);
    expect(result.errors.some((e) => e.includes("no task file docs/tasks/RA-002.md"))).toBe(true);
  });

  it("flags a dependency on an unknown task", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "READY", dependsOn: ["RA-999"] }],
    });
    const result = validate(root);
    expect(result.errors.some((e) => e.includes("depends on unknown task RA-999"))).toBe(true);
  });

  it("flags a dependency cycle", () => {
    const root = buildRepo({
      rows: [
        { order: 1, id: "RA-001", status: "READY", dependsOn: ["RA-002"] },
        { order: 2, id: "RA-002", status: "READY", dependsOn: ["RA-001"] },
      ],
    });
    const result = validate(root);
    expect(result.errors.some((e) => e.includes("dependency cycle detected"))).toBe(true);
  });

  it("flags AWAITING_AUDIT without a handoff", () => {
    const root = buildRepo({ rows: [{ order: 1, id: "RA-001", status: "AWAITING_AUDIT" }] });
    const result = validate(root);
    expect(result.errors.some((e) => e.includes("has no handoff"))).toBe(true);
  });

  it("flags AUDIT_PASSED without an audit even when a handoff exists", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: ["RA-001"],
    });
    const result = validate(root);
    expect(result.errors.some((e) => e.includes("has no audit"))).toBe(true);
  });

  it("flags a malformed task id", () => {
    const root = buildRepo({ rows: [{ order: 1, id: "RA-1", status: "READY" }] });
    // The row id will not match RA-\d{3}; parser leaves id empty for RA-1.
    const result = validate(root);
    expect(result.ok).toBe(false);
  });
});

describe("parseAuditVerdict", () => {
  it("reads a single declared verdict", () => {
    expect(parseAuditVerdict("- Werdykt: `CHANGES_REQUIRED`\n")).toEqual({
      kind: "ok",
      verdict: "CHANGES_REQUIRED",
    });
  });

  it("treats the unfilled template placeholder as ambiguous", () => {
    const parsed = parseAuditVerdict("- Werdykt: `PASS | CHANGES_REQUIRED | BLOCKED`\n");
    expect(parsed.kind).toBe("ambiguous");
  });

  it("treats a document with no verdict line as missing", () => {
    expect(parseAuditVerdict("# audit\n\nsome prose\n")).toEqual({ kind: "missing" });
  });
});

describe("validate — audit verdict enforcement", () => {
  it("accepts AUDIT_PASSED backed by a PASS verdict", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: ["RA-001"],
      audits: [{ id: "RA-001", verdict: "PASS" }],
    });
    expect(validate(root).ok).toBe(true);
  });

  it("accepts CHANGES_REQUESTED backed by a CHANGES_REQUIRED verdict", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "CHANGES_REQUESTED" }],
      handoffs: ["RA-001"],
      audits: [{ id: "RA-001", verdict: "CHANGES_REQUIRED" }],
    });
    expect(validate(root).ok).toBe(true);
  });

  it("rejects AUDIT_PASSED when the latest audit says CHANGES_REQUIRED", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: ["RA-001"],
      audits: [{ id: "RA-001", verdict: "CHANGES_REQUIRED" }],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("verdict is CHANGES_REQUIRED (expected PASS)")),
    ).toBe(true);
  });

  it("rejects DONE when the latest audit says BLOCKED", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "DONE" }],
      handoffs: ["RA-001"],
      audits: [{ id: "RA-001", verdict: "BLOCKED" }],
    });
    const result = validate(root);
    expect(result.errors.some((e) => e.includes("verdict is BLOCKED (expected PASS)"))).toBe(true);
  });

  it("uses the numerically-latest audit, not lexicographic order", () => {
    // rev 2 (PASS) supersedes rev 1 (CHANGES_REQUIRED) for an AUDIT_PASSED task.
    const passLatest = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: ["RA-001"],
      audits: [
        { id: "RA-001", rev: 1, verdict: "CHANGES_REQUIRED" },
        { id: "RA-001", rev: 2, verdict: "PASS" },
      ],
    });
    expect(validate(passLatest).ok).toBe(true);

    // Reverse: latest rev is CHANGES_REQUIRED, so AUDIT_PASSED is illegal.
    const changesLatest = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: ["RA-001"],
      audits: [
        { id: "RA-001", rev: 1, verdict: "PASS" },
        { id: "RA-001", rev: 2, verdict: "CHANGES_REQUIRED" },
      ],
    });
    expect(validate(changesLatest).ok).toBe(false);
  });

  it("rejects an audit whose verdict is missing", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: ["RA-001"],
      audits: [{ id: "RA-001", raw: "# RA-001 audit\n\nno verdict here\n" }],
    });
    const result = validate(root);
    expect(result.errors.some((e) => e.includes("declares no verdict"))).toBe(true);
  });

  it("rejects an audit whose verdict is ambiguous (unfilled template)", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "DONE" }],
      handoffs: ["RA-001"],
      audits: [{ id: "RA-001", raw: "- Werdykt: `PASS | CHANGES_REQUIRED | BLOCKED`\n" }],
    });
    const result = validate(root);
    expect(result.errors.some((e) => e.includes("ambiguous verdict"))).toBe(true);
  });
});

describe("validate — real repository", () => {
  it("passes against the actual repo task index", () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    const result = validate(repoRoot);
    if (!result.ok) {
      throw new Error(`real repo failed workflow:validate:\n${result.errors.join("\n")}`);
    }
    expect(result.rows.length).toBeGreaterThanOrEqual(26);
  });
});
