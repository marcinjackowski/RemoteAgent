import { realpath } from "node:fs/promises";

import { canonicalDigest } from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";

import {
  VerificationGateAggregate,
  VerificationGateCatalog,
  VerificationGateClass,
  VerificationGateDefinition,
  VerificationGateDeriveAggregate,
  VerificationGateOutcome,
  VerificationGateReceipt,
  VerificationGateStatus,
  VerificationGateTarget,
  type VerificationGateAggregateInput,
} from "../src/index.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

async function fixture() {
  const executable = await realpath(process.execPath);
  const definition = VerificationGateDefinition.parse({
    schema_version: 1,
    gate_id: "unit.test-first",
    gate_class: VerificationGateClass.TEST,
    executable,
    argv: ["--test", "literal;touch /tmp/not-a-shell"],
    relative_cwd: "packages/test-evidence",
    required: true,
    baseline: true,
    test_first: true,
    timeout_ms: 30_000,
    environment_profile: "HERMETIC",
    network_profile: "DENY",
    mutable_outputs: ["coverage"],
  });
  const catalog = await VerificationGateCatalog.create({
    definitions: [definition],
    executable_allowlist: [executable],
  });
  const receipt = (
    target: "BASELINE" | "CURRENT",
    outcome: "PASSED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "INFRASTRUCTURE" | "AMBIGUOUS",
  ) =>
    VerificationGateReceipt.parse({
      schema_version: 1,
      receipt_id: `receipt-${target.toLowerCase()}`,
      case_id: "case-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      operation_id: target === VerificationGateTarget.BASELINE ? "op-baseline" : "op-current",
      gate_id: definition.gate_id,
      target,
      tree_digest: target === VerificationGateTarget.BASELINE ? digest("a") : digest("b"),
      config_digest: catalog.config_digest,
      command_digest: catalog.commandDigest(definition.gate_id),
      outcome,
      exit_code:
        outcome === VerificationGateOutcome.PASSED
          ? 0
          : outcome === VerificationGateOutcome.FAILED
            ? 1
            : null,
      duration_ms: 12,
      signal: null,
      log_artifact: {
        artifact_id: `log-${target.toLowerCase()}`,
        scope: { case_id: "case-1", workspace_id: "workspace-1" },
        relative_path: `case-1/workspace-1/log-${target.toLowerCase()}.log`,
        digest: digest("c"),
        byte_length: 0,
        complete: true,
        original_byte_length: 0,
      },
      log_digest: digest("c"),
    });
  const input = (receipts: ReturnType<typeof receipt>[]): VerificationGateAggregateInput => ({
    catalog,
    receipts,
    case_id: "case-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    current_tree_digest: digest("b"),
    baseline_tree_digest: digest("a"),
    operation_bindings: [
      { gate_id: definition.gate_id, target: "BASELINE", operation_id: "op-baseline" },
      { gate_id: definition.gate_id, target: "CURRENT", operation_id: "op-current" },
    ],
  });
  return { catalog, definition, receipt, input };
}

describe("VerificationGate contracts and catalog", () => {
  it("uses strict versioned schemas and requires test-first gates to be required baseline gates", async () => {
    const { definition, receipt } = await fixture();
    expect(() => VerificationGateDefinition.parse({ ...definition, injected: true })).toThrow();
    expect(() =>
      VerificationGateReceipt.parse({ ...receipt("CURRENT", "PASSED"), verdict: "PASSED" }),
    ).toThrow();
    expect(() => VerificationGateAggregate.parse({ schema_version: 1 })).toThrow();
    expect(() => VerificationGateDefinition.parse({ ...definition, required: false })).toThrow(
      /test-first/u,
    );
    expect(() => VerificationGateDefinition.parse({ ...definition, baseline: false })).toThrow(
      /test-first/u,
    );
    expect(() =>
      VerificationGateDefinition.parse({ ...definition, gate_class: "MODEL_INVENTED" }),
    ).toThrow();
    expect(definition.argv).toEqual(["--test", "literal;touch /tmp/not-a-shell"]);
  });

  it("requires an exact scoped durable log and consistent process facts", async () => {
    const { receipt } = await fixture();
    const passed = receipt("CURRENT", "PASSED");
    expect(() =>
      VerificationGateReceipt.parse({ ...passed, log_artifact: null, log_digest: null }),
    ).toThrow(/log/u);
    expect(() =>
      VerificationGateReceipt.parse({
        ...receipt("CURRENT", "FAILED"),
        log_artifact: null,
        log_digest: null,
      }),
    ).toThrow(/INFRASTRUCTURE/u);
    expect(() => VerificationGateReceipt.parse({ ...passed, log_digest: digest("d") })).toThrow(
      /digest/u,
    );
    expect(() =>
      VerificationGateReceipt.parse({
        ...passed,
        log_artifact: {
          ...passed.log_artifact,
          scope: { case_id: "case-1", workspace_id: "workspace-foreign" },
        },
      }),
    ).toThrow(/workspace/u);
    expect(() => VerificationGateReceipt.parse({ ...passed, signal: "SIGKILL" })).toThrow(
      /signal/u,
    );
    expect(() => VerificationGateReceipt.parse({ ...passed, signal: "NOT_A_SIGNAL" })).toThrow();
    expect(
      VerificationGateReceipt.parse({
        ...passed,
        outcome: VerificationGateOutcome.INFRASTRUCTURE,
        exit_code: 0,
      }).exit_code,
    ).toBe(0);
    expect(() =>
      VerificationGateReceipt.parse({
        ...passed,
        outcome: VerificationGateOutcome.TIMED_OUT,
        exit_code: 0,
      }),
    ).toThrow(/exit code/u);
  });

  it("recomputes a canonical order-independent digest and rejects duplicate IDs", async () => {
    const { catalog, definition } = await fixture();
    expect(catalog.config_digest).toBe(
      canonicalDigest({
        definitions: [definition],
        executable_allowlist: [definition.executable],
      }),
    );
    await expect(
      VerificationGateCatalog.create({
        definitions: [definition, definition],
        executable_allowlist: [definition.executable],
      }),
    ).rejects.toThrow(/unique/u);
  });

  it("bounds the code-owned catalog at 128 gates", async () => {
    const { definition } = await fixture();
    const definitions = Array.from({ length: 128 }, (_, index) => ({
      ...definition,
      gate_id: `bounded.gate-${index}`,
      argv: [...definition.argv],
      mutable_outputs: [...definition.mutable_outputs],
    }));
    await expect(
      VerificationGateCatalog.create({
        definitions,
        executable_allowlist: [definition.executable],
      }),
    ).resolves.toBeInstanceOf(VerificationGateCatalog);
    await expect(
      VerificationGateCatalog.create({
        definitions: [
          ...definitions,
          {
            ...definition,
            gate_id: "bounded.gate-128",
            argv: [...definition.argv],
            mutable_outputs: [...definition.mutable_outputs],
          },
        ],
        executable_allowlist: [definition.executable],
      }),
    ).rejects.toThrow(/128/u);
  });

  it("deep-snapshots definitions and keeps exposed command configuration immutable", async () => {
    const { catalog, definition } = await fixture();
    const before = catalog.commandDigest(definition.gate_id);
    definition.argv.push("caller-mutation");
    definition.mutable_outputs.push("caller-output");
    expect(catalog.commandDigest(definition.gate_id)).toBe(before);
    expect(catalog.definitions[0]?.argv).not.toContain("caller-mutation");
    expect(() => (catalog.definitions[0]?.argv as string[]).push("exposed-mutation")).toThrow();
    expect(() =>
      (catalog.definitions[0]?.mutable_outputs as string[]).push("exposed-output"),
    ).toThrow();
    expect(catalog.commandDigest(definition.gate_id)).toBe(before);
  });

  it("rejects relative, non-canonical and non-allowlisted executables", async () => {
    const { definition } = await fixture();
    await expect(
      VerificationGateCatalog.create({ definitions: [definition], executable_allowlist: ["node"] }),
    ).rejects.toThrow(/absolute/u);
    await expect(
      VerificationGateCatalog.create({
        definitions: [{ ...definition, executable: "/bin/sh" }],
        executable_allowlist: [definition.executable],
      }),
    ).rejects.toThrow(/allowlisted/u);
  });
});

describe("VerificationGateDeriveAggregate", () => {
  it("passes test-first only for baseline FAILED and current PASSED", async () => {
    const { receipt, input } = await fixture();
    expect(
      VerificationGateDeriveAggregate(
        input([receipt("BASELINE", "FAILED"), receipt("CURRENT", "PASSED")]),
      ).status,
    ).toBe(VerificationGateStatus.PASSED);
    expect(
      VerificationGateDeriveAggregate(
        input([receipt("BASELINE", "PASSED"), receipt("CURRENT", "PASSED")]),
      ).status,
    ).toBe(VerificationGateStatus.FAILED);
    expect(
      VerificationGateDeriveAggregate(
        input([receipt("BASELINE", "FAILED"), receipt("CURRENT", "FAILED")]),
      ).status,
    ).toBe(VerificationGateStatus.FAILED);
    expect(
      VerificationGateDeriveAggregate(
        input([receipt("BASELINE", "AMBIGUOUS"), receipt("CURRENT", "PASSED")]),
      ).status,
    ).toBe(VerificationGateStatus.INCONCLUSIVE);
  });

  it("rejects empty, missing and duplicate receipt sets", async () => {
    const { receipt, input } = await fixture();
    expect(() => VerificationGateDeriveAggregate(input([]))).toThrow(/zero/u);
    expect(() => VerificationGateDeriveAggregate(input([receipt("CURRENT", "PASSED")]))).toThrow(
      /baseline/u,
    );
    const current = receipt("CURRENT", "PASSED");
    expect(() => VerificationGateDeriveAggregate(input([current, current]))).toThrow(/duplicate/u);
    expect(() =>
      VerificationGateDeriveAggregate({
        ...input([receipt("BASELINE", "FAILED"), current]),
        receipts: [{ ...receipt("BASELINE", "FAILED"), receipt_id: current.receipt_id }, current],
      }),
    ).toThrow(/receipt_id/u);
  });

  it.each([
    ["tree_digest", digest("d"), /tree/u],
    ["config_digest", digest("d"), /config/u],
    ["command_digest", digest("d"), /command/u],
    ["operation_id", "op-foreign", /operation/u],
  ] as const)("rejects a foreign %s binding", async (field, value, message) => {
    const { receipt, input } = await fixture();
    const baseline = receipt("BASELINE", "FAILED");
    const current = { ...receipt("CURRENT", "PASSED"), [field]: value };
    expect(() => VerificationGateDeriveAggregate(input([baseline, current]))).toThrow(message);
  });

  it("rejects foreign gates, cases, workspaces and runs", async () => {
    const { receipt, input } = await fixture();
    const baseline = receipt("BASELINE", "FAILED");
    for (const patch of [
      { gate_id: "foreign" },
      { case_id: "foreign" },
      { workspace_id: "foreign" },
      { run_id: "foreign" },
    ]) {
      expect(() =>
        VerificationGateDeriveAggregate(
          input([baseline, { ...receipt("CURRENT", "PASSED"), ...patch }]),
        ),
      ).toThrow();
    }
  });

  it("binds each gate and target to its own operation", async () => {
    const { catalog: firstCatalog, definition, receipt } = await fixture();
    const second = VerificationGateDefinition.parse({
      ...definition,
      gate_id: "lint.required",
      gate_class: VerificationGateClass.LINT,
      argv: ["--lint"],
      baseline: false,
      test_first: false,
    });
    const catalog = await VerificationGateCatalog.create({
      definitions: [definition, second],
      executable_allowlist: [...firstCatalog.executable_allowlist],
    });
    const baseline = { ...receipt("BASELINE", "FAILED"), config_digest: catalog.config_digest };
    const current = { ...receipt("CURRENT", "PASSED"), config_digest: catalog.config_digest };
    const lint = VerificationGateReceipt.parse({
      ...current,
      receipt_id: "receipt-lint",
      gate_id: second.gate_id,
      operation_id: "op-lint-current",
      command_digest: catalog.commandDigest(second.gate_id),
    });
    baseline.command_digest = catalog.commandDigest(definition.gate_id);
    current.command_digest = catalog.commandDigest(definition.gate_id);
    const aggregate = VerificationGateDeriveAggregate({
      catalog,
      receipts: [baseline, current, lint],
      case_id: "case-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      current_tree_digest: digest("b"),
      baseline_tree_digest: digest("a"),
      operation_bindings: [
        { gate_id: definition.gate_id, target: "BASELINE", operation_id: "op-baseline" },
        { gate_id: definition.gate_id, target: "CURRENT", operation_id: "op-current" },
        { gate_id: second.gate_id, target: "CURRENT", operation_id: "op-lint-current" },
      ],
    });
    expect(aggregate.status).toBe(VerificationGateStatus.PASSED);
    expect(() =>
      VerificationGateDeriveAggregate({
        catalog,
        receipts: [baseline, current, lint],
        case_id: "case-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        current_tree_digest: digest("b"),
        baseline_tree_digest: digest("a"),
        operation_bindings: [
          { gate_id: definition.gate_id, target: "BASELINE", operation_id: "op-baseline" },
          { gate_id: definition.gate_id, target: "CURRENT", operation_id: "op-current" },
          { gate_id: second.gate_id, target: "CURRENT", operation_id: "op-wrong" },
        ],
      }),
    ).toThrow(/operation/u);
  });

  it("rejects duplicate operations, non-baseline targets and non-exact binding sets", async () => {
    const { catalog: firstCatalog, definition, receipt, input } = await fixture();
    const receipts = [receipt("BASELINE", "FAILED"), receipt("CURRENT", "PASSED")];
    const expected = input(receipts);
    expect(() =>
      VerificationGateDeriveAggregate({
        ...expected,
        operation_bindings: expected.operation_bindings.map((binding) => ({
          ...binding,
          operation_id: "op-same",
        })),
      }),
    ).toThrow(/distinct/u);
    expect(() =>
      VerificationGateDeriveAggregate({
        ...expected,
        operation_bindings: expected.operation_bindings.slice(0, 1),
      }),
    ).toThrow(/exactly/u);
    expect(() =>
      VerificationGateDeriveAggregate({
        ...expected,
        operation_bindings: [
          ...expected.operation_bindings,
          { gate_id: definition.gate_id, target: "CURRENT", operation_id: "op-extra" },
        ],
      }),
    ).toThrow(/duplicate/u);

    const currentOnly = VerificationGateDefinition.parse({
      ...definition,
      gate_id: "current-only",
      baseline: false,
      test_first: false,
    });
    const catalog = await VerificationGateCatalog.create({
      definitions: [currentOnly],
      executable_allowlist: [...firstCatalog.executable_allowlist],
    });
    const invalidBaseline = {
      ...receipt("BASELINE", "FAILED"),
      gate_id: currentOnly.gate_id,
      config_digest: catalog.config_digest,
      command_digest: catalog.commandDigest(currentOnly.gate_id),
    };
    expect(() =>
      VerificationGateDeriveAggregate({
        catalog,
        receipts: [invalidBaseline],
        case_id: "case-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        current_tree_digest: digest("b"),
        baseline_tree_digest: digest("a"),
        operation_bindings: [
          { gate_id: currentOnly.gate_id, target: "BASELINE", operation_id: "op-baseline" },
        ],
      }),
    ).toThrow(/baseline|foreign/u);
  });
});
