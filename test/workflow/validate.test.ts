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
  /** Verbatim file name, bypassing the canonical `AUDIT-NN.md` naming. */
  fileName?: string;
  /** Declared verdict; ignored when `raw` is set. Defaults to "PASS". */
  verdict?: string;
  /** Raw file body, bypassing the verdict template (for malformed cases). */
  raw?: string;
}

interface HandoffSpec {
  id: string;
  /** Revision number -> HANDOFF-<NN>.md. Defaults to 1. */
  rev?: number;
  /** Verbatim file name, bypassing the canonical `HANDOFF-NN.md` naming. */
  fileName?: string;
  /** Include an explicit Decision Request marker in the body. */
  decisionRequest?: boolean;
  /** Raw file body, bypassing the default template. */
  raw?: string;
}

interface RepoSpec {
  rows: RowSpec[];
  /**
   * Literal body-row (or trailing-content) lines appended verbatim after the
   * generated `spec.rows`, before the terminating blank line. Use this to inject
   * malformed rows, gaps, unrelated tables or extra sections into the fixture.
   */
  rawRows?: string[];
  /**
   * Fully raw TASK_INDEX.md content, bypassing the header/row builder entirely.
   * When set, `rows`/`rawRows` are ignored for the index file (but `rows` still
   * drives the default task-file list). Use this for header/separator/section
   * anchoring cases that must control every line.
   */
  rawIndex?: string;
  /** Task ids for which a docs/tasks/<id>.md file should be created. */
  taskFiles?: string[];
  /** Handoffs to create; a bare string means a single plain HANDOFF-01 for that id. */
  handoffs?: Array<string | HandoffSpec>;
  /** Audits to create; a bare string means a single PASS audit for that id. */
  audits?: Array<string | AuditSpec>;
}

function buildRepo(spec: RepoSpec): string {
  const root = mkdtempSync(join(tmpdir(), "ra-wf-"));
  roots.push(root);
  const tasksDir = join(root, "docs", "tasks");
  mkdirSync(tasksDir, { recursive: true });

  if (spec.rawIndex !== undefined) {
    writeFileSync(join(tasksDir, "TASK_INDEX.md"), spec.rawIndex);
  } else {
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
    const rawRows = spec.rawRows ?? [];
    writeFileSync(join(tasksDir, "TASK_INDEX.md"), [...header, ...body, ...rawRows, ""].join("\n"));
  }

  const taskFiles = spec.taskFiles ?? spec.rows.map((r) => r.id);
  for (const id of taskFiles) writeFileSync(join(tasksDir, `${id}.md`), `# ${id}\n`);

  for (const entry of spec.handoffs ?? []) {
    const handoff: HandoffSpec = typeof entry === "string" ? { id: entry } : entry;
    const dir = join(root, "docs", "handoffs", handoff.id);
    mkdirSync(dir, { recursive: true });
    const nn = String(handoff.rev ?? 1).padStart(2, "0");
    const marker = handoff.decisionRequest ? "\n## Decision Request\n\nProszę o decyzję.\n" : "";
    const body = handoff.raw ?? `# ${handoff.id} handoff\n${marker}`;
    writeFileSync(join(dir, handoff.fileName ?? `HANDOFF-${nn}.md`), body);
  }
  for (const entry of spec.audits ?? []) {
    const audit: AuditSpec = typeof entry === "string" ? { id: entry } : entry;
    const dir = join(root, "docs", "audits", audit.id);
    mkdirSync(dir, { recursive: true });
    const nn = String(audit.rev ?? 1).padStart(2, "0");
    const body = audit.raw ?? `# ${audit.id} audit\n\n- Werdykt: \`${audit.verdict ?? "PASS"}\`\n`;
    writeFileSync(join(dir, audit.fileName ?? `AUDIT-${nn}.md`), body);
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

  it("rejects two separate verdict declaration lines as ambiguous", () => {
    const parsed = parseAuditVerdict("- Werdykt: `PASS`\n- Werdykt: `CHANGES_REQUIRED`\n");
    expect(parsed.kind).toBe("ambiguous");
  });

  it("rejects a repeated token on one declaration line as ambiguous", () => {
    // Raw occurrences are counted, so `PASS PASS` must not collapse to a single PASS.
    const parsed = parseAuditVerdict("- Werdykt: `PASS PASS`\n");
    expect(parsed.kind).toBe("ambiguous");
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

  it("rejects a status backed by an audit with two conflicting verdict lines", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: ["RA-001"],
      audits: [{ id: "RA-001", raw: "- Werdykt: `PASS`\n- Werdykt: `CHANGES_REQUIRED`\n" }],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("ambiguous verdict"))).toBe(true);
  });

  it("rejects a status backed by an audit with a repeated verdict token", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: ["RA-001"],
      audits: [{ id: "RA-001", raw: "- Werdykt: `PASS PASS`\n" }],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("ambiguous verdict"))).toBe(true);
  });
});

describe("validate — BLOCKED provenance by newest artifact", () => {
  it("accepts a procedural block: newest handoff declares a Decision Request, no audit", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "BLOCKED" }],
      handoffs: [{ id: "RA-001", rev: 1, decisionRequest: true }],
    });
    const result = validate(root);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts a procedural block raised after an earlier CHANGES_REQUIRED audit", () => {
    // HANDOFF-01 -> AUDIT-01 CHANGES_REQUIRED -> HANDOFF-02 (Decision Request) -> BLOCKED.
    // The newest artifact is the handoff, so the stale audit is not the block's cause.
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "BLOCKED" }],
      handoffs: [
        { id: "RA-001", rev: 1 },
        { id: "RA-001", rev: 2, decisionRequest: true },
      ],
      audits: [{ id: "RA-001", rev: 1, verdict: "CHANGES_REQUIRED" }],
    });
    const result = validate(root);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts an audit-driven block: newest audit verdict is BLOCKED", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "BLOCKED" }],
      handoffs: [{ id: "RA-001", rev: 1 }],
      audits: [{ id: "RA-001", rev: 1, verdict: "BLOCKED" }],
    });
    expect(validate(root).ok).toBe(true);
  });

  it("rejects a stale CHANGES_REQUIRED audit with a newer handoff that has no Decision Request", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "BLOCKED" }],
      handoffs: [
        { id: "RA-001", rev: 1 },
        { id: "RA-001", rev: 2 }, // no Decision Request marker
      ],
      audits: [{ id: "RA-001", rev: 1, verdict: "CHANGES_REQUIRED" }],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("declares no Decision Request"))).toBe(true);
  });

  it("rejects a conflict: an older BLOCKED audit cannot rescue a newer non-Decision-Request handoff", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "BLOCKED" }],
      handoffs: [
        { id: "RA-001", rev: 1 },
        { id: "RA-001", rev: 2 }, // newest, but no Decision Request
      ],
      audits: [{ id: "RA-001", rev: 1, verdict: "BLOCKED" }],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("declares no Decision Request"))).toBe(true);
  });

  it("rejects an undocumented block with no handoff and no audit (fail-closed)", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "BLOCKED" }],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("no handoff or audit documents the block"))).toBe(
      true,
    );
  });

  it("rejects an audit-driven block whose newest audit says PASS", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "BLOCKED" }],
      handoffs: [{ id: "RA-001", rev: 1 }],
      audits: [{ id: "RA-001", rev: 1, verdict: "PASS" }],
    });
    const result = validate(root);
    expect(result.errors.some((e) => e.includes("verdict is PASS (expected BLOCKED)"))).toBe(true);
  });

  it("rejects an audit-driven block whose newest audit says CHANGES_REQUIRED", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "BLOCKED" }],
      handoffs: [{ id: "RA-001", rev: 1 }],
      audits: [{ id: "RA-001", rev: 1, verdict: "CHANGES_REQUIRED" }],
    });
    const result = validate(root);
    expect(
      result.errors.some((e) => e.includes("verdict is CHANGES_REQUIRED (expected BLOCKED)")),
    ).toBe(true);
  });
});

describe("validate — canonical artifact revision names", () => {
  it("rejects a conflicting AUDIT-01 / AUDIT-001 pair and does not silently pick one", () => {
    // AUDIT-001 (PASS) must not be able to shadow AUDIT-01 (CHANGES_REQUIRED).
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: ["RA-001"],
      audits: [
        { id: "RA-001", fileName: "AUDIT-01.md", verdict: "CHANGES_REQUIRED" },
        { id: "RA-001", fileName: "AUDIT-001.md", verdict: "PASS" },
      ],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("files for revision 1"))).toBe(true);
    expect(result.errors.some((e) => e.includes("non-canonical revision name"))).toBe(true);
  });

  it("rejects a conflicting HANDOFF-01 / HANDOFF-001 pair", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "BLOCKED" }],
      handoffs: [
        { id: "RA-001", fileName: "HANDOFF-01.md" },
        { id: "RA-001", fileName: "HANDOFF-001.md", decisionRequest: true },
      ],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("files for revision 1"))).toBe(true);
    expect(result.errors.some((e) => e.includes("non-canonical revision name"))).toBe(true);
  });

  it("flags two files that resolve to the same numeric revision", () => {
    // AUDIT-02 and AUDIT-002 both denote revision 2: an explicit duplicate error
    // fires (plus a non-canonical error for AUDIT-002), and neither is selected.
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: ["RA-001"],
      audits: [
        { id: "RA-001", fileName: "AUDIT-02.md", verdict: "PASS" },
        { id: "RA-001", fileName: "AUDIT-002.md", verdict: "CHANGES_REQUIRED" },
      ],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("files for revision 2"))).toBe(true);
    expect(result.errors.some((e) => e.includes("non-canonical revision name"))).toBe(true);
  });

  it("rejects revision 00", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AWAITING_AUDIT" }],
      handoffs: [{ id: "RA-001", fileName: "HANDOFF-00.md" }],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("non-canonical revision name"))).toBe(true);
    // 00 is not counted as a handoff, so the missing-handoff rule also fires.
    expect(result.errors.some((e) => e.includes("has no handoff"))).toBe(true);
  });

  it("rejects a single-digit (unpadded) revision name", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AWAITING_AUDIT" }],
      handoffs: [{ id: "RA-001", fileName: "HANDOFF-1.md" }],
    });
    const result = validate(root);
    expect(result.errors.some((e) => e.includes("non-canonical revision name"))).toBe(true);
  });

  it("selects revision 10 over 09 by numeric value", () => {
    // AUDIT-10 (PASS) is the latest; AUDIT-09 (CHANGES_REQUIRED) must not win.
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: ["RA-001"],
      audits: [
        { id: "RA-001", rev: 9, verdict: "CHANGES_REQUIRED" },
        { id: "RA-001", rev: 10, verdict: "PASS" },
      ],
    });
    expect(validate(root).ok).toBe(true);

    // Reverse the verdicts: 10 is CHANGES_REQUIRED, so AUDIT_PASSED is illegal.
    const reversed = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: ["RA-001"],
      audits: [
        { id: "RA-001", rev: 9, verdict: "PASS" },
        { id: "RA-001", rev: 10, verdict: "CHANGES_REQUIRED" },
      ],
    });
    expect(validate(reversed).ok).toBe(false);
  });

  it("accepts a three-digit revision like 100", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AWAITING_AUDIT" }],
      handoffs: [{ id: "RA-001", fileName: "HANDOFF-100.md" }],
    });
    expect(validate(root).ok).toBe(true);
  });
});

describe("validate — disallowed (malformed) artifact entries", () => {
  it("does not let a misnamed newer audit leave a stale older PASS as latest", () => {
    // The canonical AUDIT-01 says PASS; the newer, misnamed AUDIT-02-final says
    // CHANGES_REQUIRED. Silently skipping it would keep the stale PASS and pass an
    // AUDIT_PASSED task; instead the disallowed entry must fail validation.
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: ["RA-001"],
      audits: [
        { id: "RA-001", rev: 1, verdict: "PASS" },
        { id: "RA-001", fileName: "AUDIT-02-final.md", verdict: "CHANGES_REQUIRED" },
      ],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("AUDIT-02-final.md is not an allowed"))).toBe(true);
  });

  it("rejects a leading-suffix name AUDIT-final-02.md", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AWAITING_AUDIT" }],
      handoffs: ["RA-001"],
      audits: [{ id: "RA-001", fileName: "AUDIT-final-02.md" }],
    });
    const result = validate(root);
    expect(result.errors.some((e) => e.includes("AUDIT-final-02.md is not an allowed"))).toBe(true);
  });

  it("rejects a wrong extension AUDIT-02.txt", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AWAITING_AUDIT" }],
      handoffs: ["RA-001"],
      audits: [{ id: "RA-001", fileName: "AUDIT-02.txt" }],
    });
    const result = validate(root);
    expect(result.errors.some((e) => e.includes("AUDIT-02.txt is not an allowed"))).toBe(true);
  });

  it("rejects a malformed prefix AUDITT-02.md", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AWAITING_AUDIT" }],
      handoffs: ["RA-001"],
      audits: [{ id: "RA-001", fileName: "AUDITT-02.md" }],
    });
    const result = validate(root);
    expect(result.errors.some((e) => e.includes("AUDITT-02.md is not an allowed"))).toBe(true);
  });

  it("rejects a stray non-artifact file in a handoff directory", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AWAITING_AUDIT" }],
      handoffs: [
        { id: "RA-001", rev: 1 },
        { id: "RA-001", fileName: "README.md" },
      ],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("README.md is not an allowed HANDOFF"))).toBe(true);
  });
});

describe("validate — AUDIT-06 audit/handoff revision causality", () => {
  // Negatives: the newest artifact contradicts the status's place in the cycle,
  // so a stale verdict must not certify newer, unaudited work.
  it("rejects AWAITING_AUDIT whose latest handoff is older than the latest audit", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AWAITING_AUDIT" }],
      handoffs: [{ id: "RA-001", rev: 1 }],
      audits: [{ id: "RA-001", rev: 2, verdict: "PASS" }],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes(
          "is AWAITING_AUDIT but latest handoff revision 1 is not newer than latest audit revision 2",
        ),
      ),
    ).toBe(true);
  });

  it("rejects AUDIT_PASSED backed by a stale PASS audit older than the latest handoff", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: [{ id: "RA-001", rev: 2 }],
      audits: [{ id: "RA-001", rev: 1, verdict: "PASS" }],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes(
          "latest audit revision 1 is older than latest handoff revision 2; that handoff has not been audited",
        ),
      ),
    ).toBe(true);
  });

  it("rejects DONE backed by a stale PASS audit older than the latest handoff", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "DONE" }],
      handoffs: [{ id: "RA-001", rev: 2 }],
      audits: [{ id: "RA-001", rev: 1, verdict: "PASS" }],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes(
          "latest audit revision 1 is older than latest handoff revision 2; that handoff has not been audited",
        ),
      ),
    ).toBe(true);
  });

  it("rejects CHANGES_REQUESTED backed by a stale CHANGES_REQUIRED audit older than the latest handoff", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "CHANGES_REQUESTED" }],
      handoffs: [{ id: "RA-001", rev: 2 }],
      audits: [{ id: "RA-001", rev: 1, verdict: "CHANGES_REQUIRED" }],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes(
          "latest audit revision 1 is older than latest handoff revision 2; that handoff has not been audited",
        ),
      ),
    ).toBe(true);
  });

  // Positive boundaries: the newest artifact is consistent with the status.
  it("accepts AWAITING_AUDIT with a fresh handoff and no audit yet", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AWAITING_AUDIT" }],
      handoffs: [{ id: "RA-001", rev: 1 }],
    });
    expect(validate(root).ok).toBe(true);
  });

  it("accepts AWAITING_AUDIT whose handoff rev6 post-dates audit rev5", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AWAITING_AUDIT" }],
      handoffs: [{ id: "RA-001", rev: 6 }],
      audits: [{ id: "RA-001", rev: 5, verdict: "CHANGES_REQUIRED" }],
    });
    expect(validate(root).ok).toBe(true);
  });

  it("accepts AUDIT_PASSED with an equal handoff/audit revision PASS", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: [{ id: "RA-001", rev: 1 }],
      audits: [{ id: "RA-001", rev: 1, verdict: "PASS" }],
    });
    expect(validate(root).ok).toBe(true);
  });

  it("accepts AUDIT_PASSED whose audit rev2 PASS post-dates handoff rev1", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "AUDIT_PASSED" }],
      handoffs: [{ id: "RA-001", rev: 1 }],
      audits: [{ id: "RA-001", rev: 2, verdict: "PASS" }],
    });
    expect(validate(root).ok).toBe(true);
  });

  it("accepts CHANGES_REQUESTED with an equal rev2 handoff/audit CHANGES_REQUIRED", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "CHANGES_REQUESTED" }],
      handoffs: [{ id: "RA-001", rev: 2 }],
      audits: [{ id: "RA-001", rev: 2, verdict: "CHANGES_REQUIRED" }],
    });
    expect(validate(root).ok).toBe(true);
  });
});

describe("validate — AUDIT-06 dependency-status gating", () => {
  // Positives: the dependency graph is consistent with each dependent's status.
  it("accepts a task with no dependencies as READY", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "READY" }],
    });
    const result = validate(root);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts a DONE dependency unblocking a dependent that is READY, IN_PROGRESS or DONE", () => {
    // RA-001 is DONE (handoff + PASS audit); each variant of the dependent is
    // legal because its only dependency is delivered. The DONE variant carries
    // its own handoff + PASS audit so the assertion isolates dependency gating.
    const forDependent = (status: string) =>
      buildRepo({
        rows: [
          { order: 1, id: "RA-001", status: "DONE" },
          { order: 2, id: "RA-002", status, dependsOn: ["RA-001"] },
        ],
        handoffs: status === "DONE" ? ["RA-001", "RA-002"] : ["RA-001"],
        audits: status === "DONE" ? ["RA-001", "RA-002"] : ["RA-001"],
      });

    for (const status of ["READY", "IN_PROGRESS", "DONE"]) {
      const result = validate(forDependent(status));
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it("accepts BLOCKED_BY_DEPENDENCIES while one of several dependencies is unfinished", () => {
    // RA-001 is DONE but RA-002 is still READY, so RA-003 legitimately waits.
    const root = buildRepo({
      rows: [
        { order: 1, id: "RA-001", status: "DONE" },
        { order: 2, id: "RA-002", status: "READY" },
        {
          order: 3,
          id: "RA-003",
          status: "BLOCKED_BY_DEPENDENCIES",
          dependsOn: ["RA-001", "RA-002"],
        },
      ],
      handoffs: ["RA-001"],
      audits: ["RA-001"],
    });
    const result = validate(root);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts BLOCKED with pending dependencies given a Decision Request provenance", () => {
    // BLOCKED is exempt from the dependency gate; the newest artifact is a
    // handoff declaring a Decision Request, so the block is documented.
    const root = buildRepo({
      rows: [
        { order: 1, id: "RA-001", status: "READY" },
        { order: 2, id: "RA-002", status: "BLOCKED", dependsOn: ["RA-001"] },
      ],
      handoffs: [{ id: "RA-002", rev: 1, decisionRequest: true }],
    });
    const result = validate(root);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts BLOCKED with completed dependencies given a Decision Request provenance", () => {
    const root = buildRepo({
      rows: [
        { order: 1, id: "RA-001", status: "DONE" },
        { order: 2, id: "RA-002", status: "BLOCKED", dependsOn: ["RA-001"] },
      ],
      handoffs: ["RA-001", { id: "RA-002", rev: 1, decisionRequest: true }],
      audits: ["RA-001"],
    });
    const result = validate(root);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // Negatives: the status contradicts the delivery state of its dependencies.
  it("rejects a READY dependent whose dependency is only READY", () => {
    const root = buildRepo({
      rows: [
        { order: 1, id: "RA-001", status: "READY" },
        { order: 2, id: "RA-002", status: "READY", dependsOn: ["RA-001"] },
      ],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("depends on unfinished task(s) RA-001 (READY); every dependency must be DONE"),
      ),
    ).toBe(true);
  });

  it("rejects an IN_PROGRESS dependent whose dependency is only AUDIT_PASSED (not DONE)", () => {
    // AUDIT_PASSED is a passed audit but not yet DONE, so it does not unblock work.
    const root = buildRepo({
      rows: [
        { order: 1, id: "RA-001", status: "AUDIT_PASSED" },
        { order: 2, id: "RA-002", status: "IN_PROGRESS", dependsOn: ["RA-001"] },
      ],
      handoffs: ["RA-001"],
      audits: [{ id: "RA-001", verdict: "PASS" }],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes(
          "depends on unfinished task(s) RA-001 (AUDIT_PASSED); every dependency must be DONE",
        ),
      ),
    ).toBe(true);
  });

  it("rejects BLOCKED_BY_DEPENDENCIES when every dependency is DONE (stale)", () => {
    const root = buildRepo({
      rows: [
        { order: 1, id: "RA-001", status: "DONE" },
        { order: 2, id: "RA-002", status: "BLOCKED_BY_DEPENDENCIES", dependsOn: ["RA-001"] },
      ],
      handoffs: ["RA-001"],
      audits: ["RA-001"],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("has no unfinished dependency; it should be READY")),
    ).toBe(true);
  });

  it("rejects BLOCKED_BY_DEPENDENCIES with zero dependencies", () => {
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "BLOCKED_BY_DEPENDENCIES" }],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("has no unfinished dependency; it should be READY")),
    ).toBe(true);
  });

  it("reports an unknown dependency for BLOCKED_BY_DEPENDENCIES without a false should-be-READY hint", () => {
    // An unknown dependency's status is unknowable, so readiness cannot be
    // concluded: the unknown-dependency error fires, the "should be READY" does not.
    const root = buildRepo({
      rows: [{ order: 1, id: "RA-001", status: "BLOCKED_BY_DEPENDENCIES", dependsOn: ["RA-999"] }],
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("depends on unknown task RA-999"))).toBe(true);
    expect(result.errors.some((e) => e.includes("should be READY"))).toBe(false);
  });
});

describe("validate — AUDIT-06 strict Queue grammar", () => {
  // Canonical Queue header/separator, reused so body-line numbers are stable:
  // line 1 "# Task Index", 2 "", 3 "## Queue", 4 "", 5 HEADER, 6 SEP, 7+ body.
  const HEADER = "| Order | Task | Status | Depends on | Milestone |";
  const SEP = "|---:|---|---|---|---|";
  const queueDoc = (...bodyLines: string[]): string =>
    ["# Task Index", "", "## Queue", "", HEADER, SEP, ...bodyLines, ""].join("\n");
  const row = (order: string, id: string, status: string, deps: string): string =>
    `| ${order} | [${id}](${id}.md) Title | ${status} | ${deps} | M0 |`;
  /** Find an error carrying every expected fragment (line, value, message). */
  const errorWith = (result: { errors: readonly string[] }, ...fragments: string[]): boolean =>
    result.errors.some((e) => fragments.every((f) => e.includes(f)));

  it("rejects a duplicate Order 1, reporting the second row's line and value", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001", "RA-002"],
      rawIndex: queueDoc(row("1", "RA-001", "READY", "—"), row("1", "RA-002", "READY", "—")),
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(
      errorWith(result, "TASK_INDEX.md:8", "Queue Order 1 is out of sequence; expected 2"),
    ).toBe(true);
  });

  it("rejects a zero Order as non-positive, with line and offending value", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001"],
      rawIndex: queueDoc(row("0", "RA-001", "READY", "—")),
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(errorWith(result, "TASK_INDEX.md:7", 'Queue Order "0" is not a positive integer')).toBe(
      true,
    );
  });

  it("rejects a gap in orders (1 then 3), reporting the out-of-sequence line and value", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001", "RA-002"],
      rawIndex: queueDoc(row("1", "RA-001", "READY", "—"), row("3", "RA-002", "READY", "—")),
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(
      errorWith(result, "TASK_INDEX.md:8", "Queue Order 3 is out of sequence; expected 2"),
    ).toBe(true);
  });

  it("rejects a nonnumeric Order 'one' on a row containing RA-001", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001"],
      rawIndex: queueDoc(row("one", "RA-001", "READY", "—")),
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(
      errorWith(result, "TASK_INDEX.md:7", 'Queue Order "one" is not a positive integer'),
    ).toBe(true);
  });

  it("rejects a malformed short body row with the wrong cell count and its line", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001"],
      rawIndex: queueDoc("| 1 | [RA-001](RA-001.md) Title | READY |"),
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(errorWith(result, "TASK_INDEX.md:7", "expected exactly 5")).toBe(true);
  });

  it("rejects a dependency RA-02 as an invalid token, with line and value", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001"],
      rawIndex: queueDoc(row("1", "RA-001", "READY", "RA-02")),
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(
      errorWith(result, "TASK_INDEX.md:7", 'Queue Depends on contains an invalid token "RA-02"'),
    ).toBe(true);
  });

  it("rejects junk around a valid dependency id (foo RA-001)", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001"],
      rawIndex: queueDoc(row("1", "RA-001", "READY", "foo RA-001")),
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(
      errorWith(
        result,
        "TASK_INDEX.md:7",
        'Queue Depends on contains an invalid token "foo RA-001"',
      ),
    ).toBe(true);
  });

  it("rejects a duplicate dependency RA-001, RA-001, with line and value", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001", "RA-002"],
      rawIndex: queueDoc(
        row("1", "RA-001", "READY", "—"),
        row("2", "RA-002", "BLOCKED_BY_DEPENDENCIES", "RA-001, RA-001"),
      ),
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(
      errorWith(result, "TASK_INDEX.md:8", 'Queue Depends on lists duplicate dependency "RA-001"'),
    ).toBe(true);
  });

  it("rejects a missing ## Queue even when an identical table exists under another heading", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001"],
      rawIndex: [
        "# Task Index",
        "",
        "## Backlog",
        "",
        HEADER,
        SEP,
        row("1", "RA-001", "READY", "—"),
        "",
      ].join("\n"),
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(errorWith(result, "no `## Queue` section found")).toBe(true);
  });

  it("rejects a wrong five-column header, reporting the header line", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001"],
      rawIndex: [
        "# Task Index",
        "",
        "## Queue",
        "",
        "| Order | Task | Status | Milestone |",
        "|---|---|---|---|",
        "| 1 | [RA-001](RA-001.md) Title | READY | M0 |",
        "",
      ].join("\n"),
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(errorWith(result, "TASK_INDEX.md:5", "must open with the header")).toBe(true);
  });

  it("rejects a malformed separator with the wrong cell count, reporting its line", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001"],
      rawIndex: [
        "# Task Index",
        "",
        "## Queue",
        "",
        HEADER,
        "|---|---|---|",
        row("1", "RA-001", "READY", "—"),
        "",
      ].join("\n"),
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(errorWith(result, "TASK_INDEX.md:6", "must have exactly 5 cells")).toBe(true);
  });

  it("rejects an empty Queue body, reporting the expected first-body line", () => {
    const root = buildRepo({ rows: [], taskFiles: [], rawIndex: queueDoc() });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(errorWith(result, "TASK_INDEX.md:7", "has no body rows")).toBe(true);
  });

  it("does not turn a numeric RA row in an unrelated table outside Queue into a task", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001"],
      rawIndex: [
        "# Task Index",
        "",
        "## Queue",
        "",
        HEADER,
        SEP,
        row("1", "RA-001", "READY", "—"),
        "",
        "## Reference",
        "",
        HEADER,
        SEP,
        row("1", "RA-999", "READY", "—"),
        "",
      ].join("\n"),
    });
    const result = validate(root);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows.some((r) => r.id === "RA-999")).toBe(false);
    expect(result.errors.some((e) => e.includes("RA-999"))).toBe(false);
  });

  it("accepts exact contiguous orders with strict em dash and comma dependency cells", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001", "RA-002", "RA-003"],
      rawIndex: queueDoc(
        row("1", "RA-001", "READY", "—"),
        row("2", "RA-002", "BLOCKED_BY_DEPENDENCIES", "RA-001"),
        row("3", "RA-003", "BLOCKED_BY_DEPENDENCIES", "RA-001, RA-002"),
      ),
    });
    const result = validate(root);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(3);
  });
  it("rejects a header missing its trailing outer pipe, reporting the header line", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001"],
      rawIndex: [
        "# Task Index",
        "",
        "## Queue",
        "",
        "| Order | Task | Status | Depends on | Milestone",
        SEP,
        row("1", "RA-001", "READY", "—"),
        "",
      ].join("\n"),
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(errorWith(result, "TASK_INDEX.md:5", "must open with the header")).toBe(true);
  });

  it("rejects a separator missing its trailing outer pipe, reporting its line", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001"],
      rawIndex: [
        "# Task Index",
        "",
        "## Queue",
        "",
        HEADER,
        "|---:|---|---|---|---",
        row("1", "RA-001", "READY", "—"),
        "",
      ].join("\n"),
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(errorWith(result, "TASK_INDEX.md:6", "must have exactly 5 cells")).toBe(true);
  });

  it("rejects a five-cell separator whose one cell has only a single dash", () => {
    const root = buildRepo({
      rows: [],
      taskFiles: ["RA-001"],
      rawIndex: [
        "# Task Index",
        "",
        "## Queue",
        "",
        HEADER,
        "|---:|-|---|---|---|",
        row("1", "RA-001", "READY", "—"),
        "",
      ].join("\n"),
    });
    const result = validate(root);
    expect(result.ok).toBe(false);
    expect(errorWith(result, "TASK_INDEX.md:6", "must have exactly 5 cells")).toBe(true);
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
