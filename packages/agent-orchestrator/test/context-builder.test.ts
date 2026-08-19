import { describe, expect, it } from "vitest";
import { Provider, TrustLevel } from "@remoteagent/contracts";
import {
  buildContext,
  ContextScope,
  ContextFragment,
  ContextScopeViolationError,
  DuplicateProvenanceError,
  MandatoryContextFragmentError,
} from "../src/index.js";
import { InvalidContextBudgetError } from "../src/context/budget.js";

const scope: ContextScope = {
  caseId: "case-1",
  ownerId: "owner-1",
  connections: [
    { provider: Provider.JIRA, connectionId: "jira-1" },
    { provider: Provider.GMAIL, connectionId: "gmail-1" },
  ],
  toolNames: ["jira.read"],
};
const make = (
  kind: ContextFragment["kind"],
  reference: string,
  content = kind,
  extra: Partial<ContextFragment> = {},
): ContextFragment => ({
  kind,
  content,
  provenance: { origin: "system", reference },
  trust: TrustLevel.TRUSTED,
  ...extra,
});
const scoped = (
  kind: "entity" | "thread_excerpt" | "receipt",
  reference: string,
  extra: Partial<ContextFragment> = {},
): ContextFragment =>
  make(kind, reference, kind, {
    trust: TrustLevel.UNTRUSTED_DATA,
    scope: {
      caseId: "case-1",
      ownerId: "owner-1",
      provider: Provider.JIRA,
      connectionId: "jira-1",
    },
    ...extra,
  });
const required = () => [make("task", "task"), make("checkpoint", "checkpoint")];
const expectCode = (fn: () => unknown, error: new (...args: never[]) => Error, code: string) => {
  let thrown: unknown;
  try {
    fn();
  } catch (candidate) {
    thrown = candidate;
  }
  expect(thrown).toBeInstanceOf(error);
  expect((thrown as { code?: string }).code).toBe(code);
};

describe("context builder", () => {
  it("orders all kinds and uses a locale-independent tie-break", () => {
    const all = [
      make("tool", "z", "tool", { toolName: "jira.read" }),
      scoped("thread_excerpt", "y"),
      scoped("entity", "x"),
      make("repo_state", "w"),
      scoped("receipt", "v"),
      make("plan", "u"),
      make("checkpoint", "t"),
      make("task", "s"),
    ].reverse();
    expect(
      buildContext({ scope, budgetBytes: 10_000, fragments: all }).fragments.map(
        ({ fragment }) => fragment.kind,
      ),
    ).toEqual([
      "task",
      "checkpoint",
      "plan",
      "receipt",
      "repo_state",
      "entity",
      "thread_excerpt",
      "tool",
    ]);
    const tied = buildContext({
      scope,
      budgetBytes: 100,
      fragments: [...required(), make("plan", "\uFFFF"), make("plan", "A"), make("plan", "a")],
    });
    expect(tied.fragments.slice(2).map(({ fragment }) => fragment.provenance.reference)).toEqual([
      "A",
      "a",
      "\uFFFF",
    ]);
  });
  it("allows exact UTF-8 fit and omits whole fragments without truncation", () => {
    const result = buildContext({
      scope,
      budgetBytes: 4,
      fragments: [
        ...required().map((f) => ({ ...f, content: "é" })),
        make("plan", "optional", "123"),
      ],
    });
    expect(result.usedBytes).toBe(4);
    expect(result.omitted[0].fragment.content).toBe("123");
    expect(result.omitted[0].bytes).toBe(3);
  });
  it("rejects invalid budgets", () => {
    for (const budget of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expectCode(
        () => buildContext({ scope, budgetBytes: budget, fragments: required() }),
        InvalidContextBudgetError,
        "INVALID_CONTEXT_BUDGET",
      );
  });
  it("rejects mandatory errors, duplicates, and mandatory over-budget", () => {
    expectCode(
      () => buildContext({ scope, budgetBytes: 100, fragments: [make("task", "a")] }),
      MandatoryContextFragmentError,
      "MANDATORY_CONTEXT_FRAGMENT",
    );
    expectCode(
      () =>
        buildContext({ scope, budgetBytes: 100, fragments: [...required(), make("task", "b")] }),
      MandatoryContextFragmentError,
      "MANDATORY_CONTEXT_FRAGMENT",
    );
    expectCode(
      () =>
        buildContext({
          scope,
          budgetBytes: 3,
          fragments: [make("task", "a", "12"), make("checkpoint", "b", "12")],
        }),
      MandatoryContextFragmentError,
      "MANDATORY_CONTEXT_FRAGMENT",
    );
    expectCode(
      () =>
        buildContext({
          scope,
          budgetBytes: 100,
          fragments: [make("task", "same"), make("checkpoint", "same")],
        }),
      DuplicateProvenanceError,
      "DUPLICATE_PROVENANCE",
    );
  });
  it("rejects cross-scope and mismatched bindings", () => {
    for (const bad of [
      { caseId: "other", ownerId: "owner-1", provider: Provider.JIRA, connectionId: "jira-1" },
      { caseId: "case-1", ownerId: "other", provider: Provider.JIRA, connectionId: "jira-1" },
      {
        caseId: "case-1",
        ownerId: "owner-1",
        provider: Provider.CALENDAR as Provider,
        connectionId: "jira-1",
      },
      { caseId: "case-1", ownerId: "owner-1", provider: Provider.JIRA, connectionId: "other" },
      { caseId: "case-1", ownerId: "owner-1", provider: Provider.GMAIL, connectionId: "jira-1" },
    ])
      expectCode(
        () =>
          buildContext({
            scope,
            budgetBytes: 100,
            fragments: [...required(), scoped("entity", "e", { scope: bad })],
          }),
        ContextScopeViolationError,
        "CONTEXT_SCOPE_VIOLATION",
      );
  });
  it("enforces trust and tool provenance", () => {
    for (const origin of ["provider", "model"] as const)
      expectCode(
        () =>
          buildContext({
            scope,
            budgetBytes: 100,
            fragments: [
              ...required(),
              make("plan", "p", "x", {
                provenance: { origin, reference: "p" },
                trust: TrustLevel.TRUSTED,
              }),
            ],
          }),
        ContextScopeViolationError,
        "CONTEXT_SCOPE_VIOLATION",
      );
    for (const kind of ["entity", "thread_excerpt"] as const)
      expectCode(
        () =>
          buildContext({
            scope,
            budgetBytes: 100,
            fragments: [...required(), scoped(kind, kind, { trust: TrustLevel.TRUSTED })],
          }),
        ContextScopeViolationError,
        "CONTEXT_SCOPE_VIOLATION",
      );
    expectCode(
      () =>
        buildContext({
          scope,
          budgetBytes: 100,
          fragments: [...required(), make("entity", "missing-scope")],
        }),
      ContextScopeViolationError,
      "CONTEXT_SCOPE_VIOLATION",
    );
    expectCode(
      () =>
        buildContext({
          scope,
          budgetBytes: 100,
          fragments: [...required(), make("tool", "t", "x", { toolName: "nope" })],
        }),
      ContextScopeViolationError,
      "CONTEXT_SCOPE_VIOLATION",
    );
    expectCode(
      () =>
        buildContext({
          scope,
          budgetBytes: 100,
          fragments: [
            ...required(),
            make("tool", "t", "x", {
              toolName: "jira.read",
              provenance: { origin: "model", reference: "t" },
            }),
          ],
        }),
      ContextScopeViolationError,
      "CONTEXT_SCOPE_VIOLATION",
    );
    expectCode(
      () =>
        buildContext({
          scope,
          budgetBytes: 100,
          fragments: [
            ...required(),
            make("tool", "t", "x", {
              toolName: "jira.read",
              scope: {
                caseId: "case-1",
                ownerId: "owner-1",
                provider: Provider.JIRA,
                connectionId: "jira-1",
              },
            }),
          ],
        }),
      ContextScopeViolationError,
      "CONTEXT_SCOPE_VIOLATION",
    );
  });
  it("does not mutate input and is invariant to input order", () => {
    const fragments = [make("plan", "p", "plan"), ...required()];
    const before = structuredClone(fragments);
    const first = buildContext({ scope, budgetBytes: 100, fragments });
    const second = buildContext({ scope, budgetBytes: 100, fragments: [...fragments].reverse() });
    expect(fragments).toEqual(before);
    expect(first).toEqual(second);
  });
});
