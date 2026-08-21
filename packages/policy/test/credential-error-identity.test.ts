/**
 * RA-023-WU-00 — `CredentialRefresh*Error` is ONE class per meaning (`CTF-001`).
 *
 * This suite exists because the defect it guards against is invisible to every other
 * gate. Two same-named classes in two packages produce no type error (each import site
 * sees a valid class), no test failure (each package's own tests pass against its own
 * copy), and no runtime export collision that a value scan can see. The only symptom is
 * a `catch` that silently does not run, surfacing much later as an unhandled rejection.
 *
 * So the assertions here are deliberately about IDENTITY, not behaviour: same
 * constructor reference across packages, and `instanceof` succeeding across the
 * boundary where the two worlds actually meet.
 *
 * The imports are the point. `@remoteagent/policy` is imported through its normal
 * package entry, and the sibling's classes come from `@remoteagent/contracts` — the
 * package both depend on. `packages/database` cannot be imported here at all
 * (`packages/database` devDepends on `@remoteagent/policy`, so an edge in this
 * direction makes turbo's graph cyclic), which is exactly why the shared definition
 * lives in `contracts` rather than in either of the two packages that were colliding.
 */
import {
  CredentialRefreshConflictError as ContractsConflictError,
  CredentialRefreshIdentityError as ContractsIdentityError,
} from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";

import {
  CredentialRefreshConflictError as PolicyConflictError,
  CredentialRefreshIdentityError as PolicyIdentityError,
  assertSameIntentIdentity,
} from "../src/credential-refresh.js";

describe("there is exactly one CredentialRefreshConflictError", () => {
  it("is the SAME constructor as the one contracts defines", () => {
    // Reference equality, not structural similarity. Two structurally identical
    // classes are precisely the bug: they satisfy every type check and fail
    // `instanceof`.
    expect(PolicyConflictError).toBe(ContractsConflictError);
  });

  it("satisfies instanceof across the package boundary", () => {
    // The property a `catch` actually depends on. Before this unit, an error thrown by
    // `packages/policy` was NOT an instance of the class importable from
    // `packages/database`, so the catch block did not run.
    const thrown = new PolicyConflictError();
    expect(thrown).toBeInstanceOf(ContractsConflictError);
    expect(thrown).toBeInstanceOf(Error);
  });

  it("keeps a stable `name` regardless of which alias constructed it", () => {
    // `name` is what log-based triage branches on, so it must not depend on which
    // import path constructed the error.
    expect(new PolicyConflictError().name).toBe("CredentialRefreshConflictError");
    expect(new ContractsConflictError().name).toBe("CredentialRefreshConflictError");
  });

  it("lets a SUBCLASS report its own name, not the parent's", () => {
    // The WU-00 probe finding. The first version assigned `this.name` from a string
    // literal, so a subclass reported `CredentialRefreshConflictError` — making a future
    // narrower error indistinguishable from its base in every log line and every
    // `name`-based branch. `new.target.name` names the class actually constructed.
    class NarrowerConflict extends PolicyConflictError {}
    const sub = new NarrowerConflict();
    expect(sub.name).toBe("NarrowerConflict");
    // Still catchable as the base, which is the whole point of unifying the class.
    expect(sub).toBeInstanceOf(ContractsConflictError);
  });

  it("carries optional diagnostics without forcing a caller to invent them", () => {
    // The two throw sites know different amounts: persistence has connection and
    // revision, the refresh coordinator raises it from a terminal ABORTED intent where
    // the revision is no longer the meaningful fact. Requiring both would have made one
    // site pass placeholder values — which is how a diagnostic field becomes a lie.
    const bare = new PolicyConflictError();
    expect(bare.connectionId).toBeUndefined();
    expect(bare.message).toMatch(/lost an optimistic-concurrency race/);

    const detailed = new PolicyConflictError({ connectionId: "conn-a", expectedRevision: 7n });
    expect(detailed.connectionId).toBe("conn-a");
    expect(detailed.expectedRevision).toBe(7n);
    expect(detailed.message).toMatch(/conn-a lost revision 7/);
  });
});

describe("there is exactly one CredentialRefreshIdentityError", () => {
  it("is the SAME constructor as the one contracts defines", () => {
    expect(PolicyIdentityError).toBe(ContractsIdentityError);
  });

  it("satisfies instanceof across the package boundary", () => {
    const thrown = new PolicyIdentityError("connection");
    expect(thrown).toBeInstanceOf(ContractsIdentityError);
  });

  it("records the mismatched field, with or without an operation id", () => {
    // `field` is what a caller branches on; the id is diagnostic. The persistence layer
    // supplies both, the coordinator only the field.
    const withoutId = new PolicyIdentityError("owner");
    expect(withoutId.field).toBe("owner");
    expect(withoutId.operationId).toBeUndefined();
    expect(withoutId.message).toMatch(/refresh operation id is bound to a different owner/);

    const withId = new PolicyIdentityError("provider", "op-1");
    expect(withId.field).toBe("provider");
    expect(withId.operationId).toBe("op-1");
    expect(withId.message).toMatch(/refresh operation op-1 is bound to a different provider/);
  });

  it("is what assertSameIntentIdentity actually throws", () => {
    // Identity of the class is only useful if the real throw site uses it. Asserted
    // through the live guard rather than by constructing the error directly, and on the
    // `field` rather than merely on the class — a test that accepted any
    // identity error would also pass if the guard compared the wrong field.
    // Exactly the four immutable identity fields the guard compares — no more.
    // An earlier version of this fixture also carried `operationId`, `versionId` and
    // `status`, which `tsc` rejected (TS2353) even though vitest's transform accepted
    // it. That divergence is `CTF-004`: the package `typecheck` script is the stricter
    // gate, and it caught a test that was passing fields the signature does not take.
    const stored = {
      connectionId: "conn-a",
      ownerId: "owner-a",
      provider: "jira" as const,
      expectedRevision: 1n,
    };

    const cases: readonly [string, Record<string, unknown>][] = [
      ["connection", { connectionId: "conn-other" }],
      ["owner", { ownerId: "owner-other" }],
      ["provider", { provider: "gmail" }],
      ["expected revision", { expectedRevision: 2n }],
    ];

    for (const [field, override] of cases) {
      const error = ((): unknown => {
        try {
          assertSameIntentIdentity(stored, {
            connectionId: "conn-a",
            ownerId: "owner-a",
            provider: "jira",
            expectedRevision: 1n,
            ...override,
          });
          return null;
        } catch (thrown) {
          return thrown;
        }
      })();
      expect(error, field).toBeInstanceOf(ContractsIdentityError);
      expect((error as InstanceType<typeof ContractsIdentityError>).field, field).toBe(field);
    }
  });
});

describe("RefreshIntentStatus has one definition", () => {
  it("accepts every durable status the store can record", () => {
    // A type cannot be asserted at runtime, so this pins the VALUE SET the type
    // describes: if the contracts union and a consumer's expectation ever diverge, the
    // annotated assignment below stops compiling. `AMBIGUOUS` is listed explicitly
    // because it is the one a naive union would omit — and omitting it would force a
    // caller to report an unconfirmed side effect as success or failure.
    const all: readonly import("@remoteagent/contracts").RefreshIntentStatus[] = [
      "PENDING",
      "ACQUIRING",
      "VAULT_WRITTEN",
      "PUBLISHED",
      "ABORTED",
      "AMBIGUOUS",
    ];
    expect(all).toHaveLength(6);
    expect(all).toContain("AMBIGUOUS");
  });
});
