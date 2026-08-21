import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACCEPTANCE_CRITERIA,
  Coverage,
  FindingDecision,
  OPEN_FINDING_DECISIONS,
  partialCriteria,
} from "../../scripts/acceptance/criteria.ts";

/**
 * The Master Plan §13 acceptance matrix, verified (RA-026-WU-01/WU-02).
 *
 * WHAT THIS SUITE CAN AND CANNOT DO, stated up front because the distinction is the whole
 * honesty of RA-026. It verifies that every criterion names evidence that EXISTS — a file
 * present, a test case inside it. It cannot verify that the test proves what the criterion
 * says; that requires reading each one, which is the auditor's work and is recorded in
 * `AUDIT-01` §3.
 *
 * So this is a completeness and staleness check, not a proof. It exists because the
 * alternative — a matrix in a document — is accurate the day it is written and silently
 * wrong afterwards, and here a stale row does not merely mislead: it certifies.
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..");
const FINDINGS = await readFile(join(REPO_ROOT, "docs/audits/CROSS_TASK_FINDINGS.md"), "utf8");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("AC1: every §13 criterion has independent evidence", () => {
  it("covers exactly criteria 1 through 10, with no gaps or duplicates", () => {
    // §13 has ten criteria. A matrix missing one would certify a system against nine.
    expect(ACCEPTANCE_CRITERIA.map((entry) => entry.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("quotes each criterion, so the matrix cannot drift from the Master Plan", async () => {
    // Matched against the Master Plan text itself. A paraphrase would let the matrix
    // certify something subtly different from what §13 asks.
    const masterPlan = await readFile(join(REPO_ROOT, "docs/MASTER_PLAN.md"), "utf8");
    const missing = ACCEPTANCE_CRITERIA.filter(
      (entry) => !masterPlan.includes(entry.criterion),
    ).map((entry) => `${String(entry.number)}: ${entry.criterion}`);
    expect(missing).toEqual([]);
  });

  it("names at least one piece of evidence per criterion", () => {
    for (const entry of ACCEPTANCE_CRITERIA) {
      expect(
        entry.evidence.length,
        `criterion ${String(entry.number)} has no evidence`,
      ).toBeGreaterThan(0);
    }
  });

  it("every criterion names evidence that exists", async () => {
    // The check that catches staleness. A renamed or deleted test breaks the acceptance
    // suite rather than quietly leaving a criterion unevidenced — the same reasoning as
    // RA-024's "every cited control must be a file that exists", which found four wrong
    // paths in a register that read as authoritative.
    const broken: string[] = [];
    for (const entry of ACCEPTANCE_CRITERIA) {
      for (const evidence of entry.evidence) {
        const path = join(REPO_ROOT, evidence.file);
        if (!(await exists(path))) {
          broken.push(`criterion ${String(entry.number)}: missing file ${evidence.file}`);
          continue;
        }
        const contents = await readFile(path, "utf8");
        if (!contents.includes(evidence.testName)) {
          broken.push(
            `criterion ${String(entry.number)}: ${evidence.file} has no test matching "${evidence.testName}"`,
          );
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("gives multiple pieces of evidence to every criterion that makes multiple claims", () => {
    // Criterion 5 names five artifacts (branch, commits, evidence, review, MR); criterion 3
    // spans three layers. A single test cannot independently prove a compound claim, so
    // these are required to cite more than one.
    for (const number of [1, 2, 3, 5, 6, 8, 9]) {
      const entry = ACCEPTANCE_CRITERIA.find((candidate) => candidate.number === number)!;
      expect(
        entry.evidence.length,
        `criterion ${String(number)} makes several claims`,
      ).toBeGreaterThan(1);
    }
  });

  it("declares no criterion ABSENT", () => {
    // `ABSENT` exists in the type so the matrix CAN say it. If any criterion were absent,
    // RA-026 could not reach PASS, and this test is what makes that mechanical rather than
    // a judgement call.
    const absent = ACCEPTANCE_CRITERIA.filter((entry) => entry.coverage === Coverage.ABSENT);
    expect(absent.map((entry) => entry.number)).toEqual([]);
  });

  it("states a substantive gap for every PARTIAL criterion", () => {
    // An unexplained `PARTIAL` is worse than an `ABSENT`: it looks considered. The length
    // floor is crude but effective — it rejects "TODO" and "see audit".
    for (const entry of partialCriteria()) {
      expect(entry.coverage).toBe(Coverage.PARTIAL);
      expect(entry.gap ?? "", `criterion ${String(entry.number)} is PARTIAL with no gap`).not.toBe(
        "",
      );
      expect((entry.gap ?? "").length).toBeGreaterThan(200);
    }
  });

  it("records a gap ONLY on a PARTIAL criterion", () => {
    // A gap on a PROVEN criterion means one of the two fields is wrong, and it is not
    // knowable which. Rejected rather than guessed.
    for (const entry of ACCEPTANCE_CRITERIA) {
      if (entry.coverage === Coverage.PROVEN) {
        expect(
          entry.gap,
          `criterion ${String(entry.number)} is PROVEN but states a gap`,
        ).toBeUndefined();
      }
    }
  });

  it("identifies exactly the two criteria known to be partial", () => {
    // Pinned deliberately. If a third became partial, this fails and someone has to decide
    // consciously rather than adding a row; if one is closed, this fails too and the matrix
    // gets updated instead of silently over-reporting.
    expect(partialCriteria().map((entry) => entry.number)).toEqual([8, 9]);
  });
});

describe("AC2: no open BLOCKER, HIGH or MEDIUM finding", () => {
  /**
   * Parsed from the register's summary table rather than from a hand-maintained list.
   *
   * The register is the source of truth (its own header says so), so a second list here
   * would be a second source that can disagree — which is `CTF-006`'s shape applied to
   * process documents.
   */
  function summaryRows(): { id: string; severity: string; status: string }[] {
    const rows: { id: string; severity: string; status: string }[] = [];
    for (const line of FINDINGS.split("\n")) {
      const match = /^\|\s*`(CTF-\d+)`\s*\|\s*\*{0,2}(\w+)\*{0,2}\s*\|\s*(.+?)\s*\|/.exec(line);
      if (match !== null) {
        rows.push({ id: match[1]!, severity: match[2]!, status: match[3]! });
      }
    }
    return rows;
  }

  it("parses the register's summary table", () => {
    // If the parse returned nothing, every assertion below would pass vacuously — the
    // exact failure shape RA-024's empty-table probe produced.
    const rows = summaryRows();
    expect(rows.length).toBeGreaterThanOrEqual(17);
    expect(rows.map((row) => row.id)).toContain("CTF-001");
  });

  it("has no open BLOCKER, HIGH or MEDIUM", () => {
    const open = summaryRows().filter(
      (row) =>
        ["BLOCKER", "HIGH", "MEDIUM"].includes(row.severity) &&
        !row.status.includes("ZAMKNIĘTY") &&
        !row.status.includes("ADRESOWANY"),
    );
    // Listed with their status, so a failure says which and why.
    expect(open.map((row) => `${row.id} (${row.severity}): ${row.status}`)).toEqual([]);
  });

  it("confirms the four findings this milestone closed", () => {
    // `CTF-006` (HIGH) and `CTF-013` (MEDIUM) in RA-024; `CTF-016` and `CTF-017` in
    // RA-025. Asserted so a regression in the register is visible.
    const byId = new Map(summaryRows().map((row) => [row.id, row]));
    for (const id of ["CTF-006", "CTF-013", "CTF-016", "CTF-017"]) {
      expect(byId.get(id)?.status, `${id} should be closed`).toContain("ZAMKNIĘTY");
    }
  });
});

describe("AC3: every open LOW finding has an owner decision", () => {
  it("records a decision for each open register entry", () => {
    const openIds = new Set<string>();
    for (const line of FINDINGS.split("\n")) {
      const match = /^\|\s*`(CTF-\d+)`\s*\|\s*\*{0,2}(\w+)\*{0,2}\s*\|\s*(.+?)\s*\|/.exec(line);
      if (match === null) continue;
      const [, id, , status] = match;
      if (status!.includes("ZAMKNIĘTY")) continue;
      openIds.add(id!);
    }
    const decided = new Set(OPEN_FINDING_DECISIONS.map((entry) => entry.id));
    const undecided = [...openIds].filter((id) => !decided.has(id)).sort();
    // A register entry with no decision is exactly what slips through a final review.
    expect(undecided).toEqual([]);
  });

  it("gives every decision a substantive rationale", () => {
    for (const entry of OPEN_FINDING_DECISIONS) {
      expect(
        entry.rationale.length,
        `${entry.id} has a decision with no rationale`,
      ).toBeGreaterThan(120);
      expect(Object.values(FindingDecision)).toContain(entry.decision);
    }
  });

  it("decides nothing that is already closed", () => {
    // A decision on a closed finding is stale bookkeeping that makes the list look more
    // considered than it is.
    const closed = new Set<string>();
    for (const line of FINDINGS.split("\n")) {
      const match = /^\|\s*`(CTF-\d+)`\s*\|\s*\*{0,2}\w+\*{0,2}\s*\|\s*(.+?)\s*\|/.exec(line);
      if (match !== null && match[2]!.includes("ZAMKNIĘTY")) closed.add(match[1]!);
    }
    const stale = OPEN_FINDING_DECISIONS.filter((entry) => closed.has(entry.id)).map(
      (entry) => entry.id,
    );
    expect(stale).toEqual([]);
  });

  it("covers the two RA-024 gaps that are not register entries", () => {
    // `CTF-014` is in the register; the `evidence`→`audit_log` narrowing is not, because it
    // is a scope decision rather than a cross-task defect. Both touch §13.8, so both need a
    // recorded decision or AC3 is satisfied only on a technicality.
    const decided = new Set(OPEN_FINDING_DECISIONS.map((entry) => entry.id));
    expect(decided).toContain("CTF-014");
    expect(decided).toContain("AC8-evidence-durability");
  });

  it("declares no open finding above LOW", () => {
    for (const entry of OPEN_FINDING_DECISIONS) {
      expect(entry.severity, `${entry.id} is open above LOW`).toBe("LOW");
    }
  });
});

describe("AC6: PASS is not production authorization", () => {
  it("the audit states explicitly that PASS does not enable production", async () => {
    // RA-026 AC6 keeps production enablement a separate, explicit owner decision. Asserted
    // against the audit document because the risk is a reader treating `PASS` as consent —
    // and that reading has to be closed off in the document itself, not only here.
    const audit = await readFile(join(REPO_ROOT, "docs/audits/RA-026/AUDIT-01.md"), "utf8");
    expect(audit).toContain("PASS");
    expect(audit.toLowerCase()).toContain("nie jest zgodą");
  });

  it("prod remains non-deployable in the infrastructure config", async () => {
    // The same rule expressed where it has teeth. A document sentence and a config flag
    // that disagree would leave the flag winning.
    const config = await readFile(join(REPO_ROOT, "infra/cdk/src/config.ts"), "utf8");
    expect(config).toContain("deployable: false");
  });
});
