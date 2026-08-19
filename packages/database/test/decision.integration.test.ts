import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { Database } from "../src/client.js";
import {
  AppendOnlyViolationError,
  ContractViolationError,
  DecisionAnswerConflictError,
  translatePgError,
} from "../src/index.js";
import {
  CaseRepository,
  ConnectionRepository,
  DecisionRepository,
  OwnerRepository,
} from "../src/repositories/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";

const available = await ensurePostgres();

describeIntegration(
  "decision repository",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    const owners = new OwnerRepository();
    const connections = new ConnectionRepository();
    const cases = new CaseRepository();
    const decisions = new DecisionRepository();

    const request = {
      schema_version: 1 as const,
      decision_id: "decision-1",
      case_id: "case-1",
      question: "Which deployment path should be used?",
      why_now: "The current run is blocked.",
      options: [
        { id: "safe", label: "Safe", consequences: "Slower" },
        { id: "fast", label: "Fast", consequences: "Less review" },
      ],
      recommendation: "safe",
      blocked_scope: "deployment",
      checkpoint_revision: 3,
    };

    const answer = (selected_option_id = "safe") => ({
      schema_version: 1 as const,
      decision_id: request.decision_id,
      case_id: request.case_id,
      checkpoint_revision: request.checkpoint_revision,
      selected_option_id,
      note: "owner note",
      answered_by: "owner-1",
      answered_at: "2026-08-20T10:00:00.000Z",
    });

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });

    afterAll(async () => drop());

    beforeEach(async () => {
      await db.query(
        "TRUNCATE decision_answers, decisions, cases, owners RESTART IDENTITY CASCADE",
      );
      await owners.insert(db, { ownerId: "owner-1", displayName: "owner" });
      await connections.insert(db, {
        connectionId: "connection-1",
        ownerId: "owner-1",
        provider: "jira",
        displayName: "jira",
      });
      await cases.insert(db, {
        caseId: "case-1",
        ownerId: "owner-1",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["connection-1"] },
        discordThreadId: "thread-1",
      });
      await cases.insert(db, {
        caseId: "case-2",
        ownerId: "owner-1",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["connection-1"] },
        discordThreadId: "thread-2",
      });
      await decisions.insertRequest(db, request);
    });

    it("rejects UPDATE and DELETE on both decision tables", async () => {
      const update = await db
        .query("UPDATE decisions SET question = 'changed' WHERE decision_id = $1", [
          request.decision_id,
        ])
        .catch((error) => translatePgError(error) ?? error);
      expect(update).toBeInstanceOf(AppendOnlyViolationError);
      await decisions.answer(db, { answerId: "answer-1", answer: answer() });
      const deletion = await db
        .query("DELETE FROM decision_answers WHERE answer_id = $1", ["answer-1"])
        .catch((error) => translatePgError(error) ?? error);
      expect(deletion).toBeInstanceOf(AppendOnlyViolationError);
    });

    it("replays the exact answer without inserting another row", async () => {
      const input = { answerId: "answer-1", answer: answer() };
      expect((await decisions.answer(db, input)).inserted).toBe(true);
      const replay = await decisions.answer(db, input);
      expect(replay.inserted).toBe(false);
      const count = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM decision_answers",
      );
      expect(count.rows[0]?.n).toBe("1");
    });

    it.each([
      ["foreign case", { ...answer(), case_id: "case-2" }],
      ["revision", { ...answer(), checkpoint_revision: 4 }],
      ["unknown option", answer("unknown")],
    ])("rejects %s before inserting an answer", async (_name, invalid) => {
      await expect(
        decisions.answer(db, { answerId: "answer-1", answer: invalid }),
      ).rejects.toThrow();
      const count = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM decision_answers",
      );
      expect(count.rows[0]?.n).toBe("0");
    });

    it("allows exactly one winner for concurrent different answers", async () => {
      const results = await Promise.allSettled([
        decisions.answer(db, { answerId: "answer-a", answer: answer("safe") }),
        decisions.answer(db, { answerId: "answer-b", answer: answer("fast") }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((result) => result.status === "rejected");
      expect(loser && loser.status === "rejected" && loser.reason).toBeInstanceOf(
        DecisionAnswerConflictError,
      );
      const count = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM decision_answers",
      );
      expect(count.rows[0]?.n).toBe("1");
    });

    it("rejects invalid request, answer, and answerId without writes", async () => {
      await expect(
        decisions.insertRequest(db, { ...request, options: [] } as never),
      ).rejects.toBeInstanceOf(ContractViolationError);
      await expect(decisions.answer(db, { answerId: "", answer: answer() })).rejects.toBeInstanceOf(
        ContractViolationError,
      );
      await expect(
        decisions.answer(db, {
          answerId: "answer-1",
          answer: { ...answer(), schema_version: 2 } as never,
        }),
      ).rejects.toBeInstanceOf(ContractViolationError);
      const count = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM decision_answers",
      );
      expect(count.rows[0]?.n).toBe("0");
    });
  },
  available,
);
