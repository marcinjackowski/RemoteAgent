import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Runbook completeness (RA-026-WU-04, AC4).
 *
 * AC4: "a fresh operator can perform start, stop, restore and credential revoke from the
 * runbook." That is a HUMAN test and this file cannot perform it — reading your own runbook
 * and finding it clear proves nothing. What this suite does is narrower and still worth
 * having: it verifies the runbook has the STRUCTURE that makes the human test possible.
 *
 * Specifically: each of the four procedures exists, each contains an executable command
 * rather than a description of intent, and the document states what it does NOT cover. A
 * runbook that says "verify the system is healthy" is useless at 3am, and that failure is
 * detectable from the text.
 *
 * The judgement half — is it actually followable? — is the auditor's, recorded in
 * `AUDIT-01` §4.
 */
const RUNBOOK_PATH = join(import.meta.dirname, "..", "..", "docs/operations/RUNBOOK.md");
const RUNBOOK = await readFile(RUNBOOK_PATH, "utf8");

/** Extract one `## n.` section, so an assertion cannot accidentally match another. */
function section(heading: string): string {
  const start = RUNBOOK.indexOf(heading);
  if (start === -1) return "";
  const next = RUNBOOK.indexOf("\n## ", start + heading.length);
  return RUNBOOK.slice(start, next === -1 ? undefined : next);
}

describe("AC4: the runbook covers the four procedures a fresh operator needs", () => {
  const procedures: readonly [string, string][] = [
    ["start / deploy", "## 1. Deploy"],
    ["stop / kill switch", "## 3. Stop — kill switch"],
    ["credential revoke", "## 4. Credential revoke"],
    ["restore", "## 5. Restore"],
  ];

  it.each(procedures)("has a section for %s", (_name, heading) => {
    expect(section(heading)).not.toBe("");
  });

  it.each(procedures)("gives %s an executable command, not a description", (name, heading) => {
    // The property that distinguishes a usable runbook from a summary. A fenced block
    // containing a real command; "verify the system is healthy" would fail this.
    const body = section(heading);
    expect(body, `${name} has no fenced command block`).toMatch(/```(bash|sql)/);
  });

  it("states the expected RESULT for the deploy and stop procedures", () => {
    // A command with no expected output leaves the operator unable to tell success from
    // silence — which at 3am reads as success.
    expect(section("## 1. Deploy")).toContain("oczekiwane");
    // The stop procedure's expected result is a table of proven behaviours rather than a
    // single output line, because "the switch is on" is not the useful fact — "the provider
    // adapter was not called" is.
    expect(section("## 3. Stop — kill switch")).toContain("dowiedzione drillem");
  });

  it("orders the credential revoke steps, database before provider", () => {
    // Ordering is load-bearing: revoking at the provider first leaves a window where the
    // system still believes the connection is healthy and produces errors rather than a
    // clean refusal.
    const body = section("## 4. Credential revoke");
    expect(body).toContain("Kolejność jest istotna");
    expect(body.indexOf("UPDATE connections")).toBeLessThan(body.indexOf("u providera"));
  });

  it("forbids the three irreversible operations up front", () => {
    // Stated before any procedure, because they are what an operator reaches for under
    // pressure: revert the migration, retry the ambiguous write, retry the refresh.
    const head = RUNBOOK.slice(0, RUNBOOK.indexOf("## 0."));
    expect(head).toContain("migrateDown");
    expect(head).toContain("AMBIGUOUS");
    expect(head.toLowerCase()).toContain("refresh");
  });

  it("gives the restore procedure a recovery ORDER, not a checklist", () => {
    // Nine numbered steps whose order is the content: kill switch first (a worker waking
    // before it could begin with an external effect), Discord eighth (a gateway asking
    // decision questions about unreconciled cases collects approvals for unknown state).
    const body = section("## 6. Recovery order");
    expect(body).toContain("Kolejność, nie lista");
    expect(body).toContain("KILL SWITCH ON");
    // Kill switch on before Discord, and Discord before kill switch off.
    expect(body.indexOf("KILL SWITCH ON")).toBeLessThan(body.indexOf("DISCORD"));
    expect(body.indexOf("DISCORD")).toBeLessThan(body.indexOf("KILL SWITCH OFF"));
  });

  it("explains why Discord comes late despite being the control channel", () => {
    // The least intuitive ordering decision, so the one most likely to be "corrected" by a
    // future reader who does not know it was chosen.
    expect(section("## 6. Recovery order")).toContain("Dlaczego Discord jest ósmy");
  });

  it("maps every alarm class to a first action", () => {
    const body = section("## 7. Alerty");
    for (const alarm of ["dlq", "renewal-failure", "stale-lease", "cost-anomaly", "no-heartbeat"]) {
      expect(body, `no first action for ${alarm}`).toContain(alarm);
    }
  });

  it("states what the runbook does NOT cover", () => {
    // "Unmentioned" reads as "covered". This section is what keeps a fresh operator from
    // assuming the AWS restore path was exercised.
    const body = section("## 8. Czego ten runbook nie obejmuje");
    expect(body).not.toBe("");
    for (const limitation of ["deploy", "restore", "Docker"]) {
      expect(body, `limitation not stated: ${limitation}`).toContain(limitation);
    }
  });

  it("never instructs an operator to revert a migration", () => {
    // The one instruction that would make the runbook actively dangerous. Checked over the
    // WHOLE document, not one section: `migrateDown` may appear only in prohibitions.
    for (const line of RUNBOOK.split("\n")) {
      if (!line.includes("migrateDown")) continue;
      const forbidding =
        line.includes("Nie ") ||
        line.includes("nie ") ||
        line.includes("**nie**") ||
        line.includes("NIE ");
      expect(forbidding, `migrateDown mentioned without a prohibition: ${line.trim()}`).toBe(true);
    }
  });
});
