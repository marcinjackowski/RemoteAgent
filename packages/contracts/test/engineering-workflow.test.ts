import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../src/canonical.js";
import {
  assertEngineeringProcessClassAllowed,
  engineeringArtifact,
  engineeringArtifactDigest,
  engineeringArtifactKindsByStage,
  isEngineeringArtifactKindAllowedForStage,
  normalizeEngineeringWritePathAllowlist,
  assertEngineeringPathsWithinWriteAllowlist,
  EngineeringStage,
  engineeringContextManifest,
  engineeringDesignDecision,
  engineeringEvidenceBundle,
  engineeringMemoryUpdate,
  engineeringLocalCommitReceipt,
  engineeringMinimumProcessClass,
  engineeringPhase,
  engineeringOutcomeContract,
  engineeringProgramDesign,
  engineeringReviewDecision,
  engineeringRecoveryPlanV1,
  engineeringRecoveryPlanV1Digest,
  engineeringSliceContract,
  engineeringSliceImplementationReceipt,
  engineeringSystemDesign,
  engineeringTerminalReason,
  engineeringVerificationDecision,
  engineeringWriteAuthorizationScopeDigest,
  engineeringWriteAuthorizationScopeV1,
  engineeringWriteAuthorizationScopeV2Digest,
  engineeringWriteAuthorizationScopeV2,
  engineeringWriteProposalV1,
  engineeringWriteDeploymentPolicyV1,
  engineeringWriteDeploymentPolicyV1Digest,
  engineeringWriteDeploymentPolicyFromExecutionConfigV2,
  normalizeEngineeringWriteAuthorizationScope,
  normalizeEngineeringWriteAuthorizationScopeV2,
  normalizeEngineeringWriteDeploymentPolicyV1,
  type EngineeringProcessRiskFacts,
} from "../src/engineering-workflow.js";

const digest = "sha256:" + "a".repeat(64);
const base = {
  schema_version: 1,
  artifact_kind: "ProgramDesign",
  case_id: "case",
  run_id: "run",
  revision: 0,
};
const program = {
  ...base,
  call_flow: ["worker -> runtime"],
  file_tree_delta: ["add contracts"],
  key_types_and_signatures: ["ProgramDesign"],
  uncertainty_review: ["none"],
  expected_tests: ["strict parsing"],
  slice_order: ["slice-1"],
  source_digest: digest,
};
const risk = (patch: Partial<EngineeringProcessRiskFacts> = {}): EngineeringProcessRiskFacts => ({
  authority: "SERVER_OWNED",
  security_or_policy: false,
  migration: false,
  irreversible_side_effect: false,
  broad_public_contract_change: false,
  multi_module: false,
  new_architecture: false,
  deterministic_oracle: true,
  user_data: false,
  concurrency: false,
  external_side_effect: false,
  ...patch,
});

describe("engineering workflow contracts", () => {
  it("strictly binds a cross-fence recovery plan including rendered context and budget", () => {
    const plan = {
      schema_version: 1 as const,
      recovery_id: "recovery-1",
      root_recovery_id: "recovery-1",
      source_job_id: "job-source",
      source_fencing_token: 4,
      recovery_job_id: "job-recovery",
      recovery_fencing_token: 2,
      case_id: "case",
      owner_id: "owner",
      work_unit_id: "unit",
      run_id: "run",
      checkpoint_revision: 3,
      repository_id: "repo",
      workflow_deadline_at: "2026-08-26T12:00:00.000Z",
      classification: "RETRY_MODEL" as const,
      operation: {
        operation_id: "operation",
        intent_id: "intent",
        stage: EngineeringStage.SLICE_PLANNING,
        stage_attempt: 2,
        effect_class: "MODEL_CALL" as const,
        input_digest: digest,
        config_digest: digest,
        schema_digest: digest,
        scope_digest: digest,
        deadline_at: "2026-08-26T12:00:00.000Z",
        context_manifest_digest: digest,
        context_snapshot_digest: digest,
        context_packet_digest: digest,
      },
      evidence_digest: digest,
      budget_reservation: {
        stage_attempts: 1,
        model_calls: 1,
        input_tokens: 10,
        output_tokens: 10,
      },
    };
    expect(engineeringRecoveryPlanV1.parse(plan)).toEqual(plan);
    expect(engineeringRecoveryPlanV1Digest(plan)).toBe(canonicalDigest(plan));
    expect(() =>
      engineeringRecoveryPlanV1.parse({
        ...plan,
        operation: { ...plan.operation, context_packet_digest: undefined },
      }),
    ).toThrow();
    expect(() => engineeringRecoveryPlanV1.parse({ ...plan, caller_scope: ["repo"] })).toThrow(
      /unrecognized/i,
    );
    expect(() => engineeringRecoveryPlanV1.parse({ ...plan, operation: null })).toThrow(
      /requires an exact source operation/iu,
    );
    expect(() =>
      engineeringRecoveryPlanV1.parse({ ...plan, classification: "RETRY_READ_ONLY" }),
    ).toThrow(/requires READ_ONLY/iu);
    expect(() =>
      engineeringRecoveryPlanV1.parse({ ...plan, classification: "RECOVER_GATE_RECEIPTS" }),
    ).toThrow(/requires GATE_EXECUTION/iu);
    expect(() =>
      engineeringRecoveryPlanV1.parse({ ...plan, classification: "OBSERVE_LOCAL_COMMIT" }),
    ).toThrow(/requires a mutating LOCAL_COMMIT/iu);
    expect(engineeringRecoveryPlanV1Digest({ ...plan, classification: "BLOCKED" })).not.toBe(
      engineeringRecoveryPlanV1Digest(plan),
    );
    expect(
      engineeringRecoveryPlanV1Digest({
        ...plan,
        operation: { ...plan.operation, context_packet_digest: `sha256:${"b".repeat(64)}` },
      }),
    ).not.toBe(engineeringRecoveryPlanV1Digest(plan));
    expect(
      engineeringRecoveryPlanV1Digest({
        ...plan,
        budget_reservation: { ...plan.budget_reservation, model_calls: 2 },
      }),
    ).not.toBe(engineeringRecoveryPlanV1Digest(plan));
  });

  it("projects the exact deployment write policy from execution config v2", () => {
    const executionConfig = {
      schema_version: 2,
      workspace_root: "/srv/workspaces",
      baseline_root: "/srv/baselines",
      artifact_root: "/srv/artifacts",
      repository: {
        repository_id: "remote-agent",
        source_path: "/srv/source",
        base_branch: "main",
        write_path_allowlist: ["packages/z", "apps/a", "apps/a"],
      },
      gates: [],
      executable_allowlist: [],
    };
    const policy = engineeringWriteDeploymentPolicyFromExecutionConfigV2(executionConfig);
    expect(policy).toEqual({
      schema_version: 1,
      purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY",
      repository_id: "remote-agent",
      write_path_allowlist: ["apps/a", "packages/z"],
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.write_path_allowlist)).toBe(true);

    expect(() =>
      engineeringWriteDeploymentPolicyFromExecutionConfigV2({
        ...executionConfig,
        deployment_policy_digest: digest,
      }),
    ).toThrow(/unrecognized/i);
    expect(() =>
      engineeringWriteDeploymentPolicyFromExecutionConfigV2({
        ...executionConfig,
        repository: { ...executionConfig.repository, repository_id: "../foreign" },
      }),
    ).toThrow();
    expect(() =>
      engineeringWriteDeploymentPolicyFromExecutionConfigV2({
        ...executionConfig,
        repository: { ...executionConfig.repository, caller_digest: digest },
      }),
    ).toThrow(/unrecognized/i);
  });

  it("owns a frozen exhaustive stage-to-artifact-kind map and a segment-aware write cap", () => {
    expect(Object.keys(engineeringArtifactKindsByStage).sort()).toEqual(
      Object.values(EngineeringStage).sort(),
    );
    expect(Object.isFrozen(engineeringArtifactKindsByStage)).toBe(true);
    for (const kinds of Object.values(engineeringArtifactKindsByStage)) {
      expect(Object.isFrozen(kinds)).toBe(true);
      expect(kinds.length).toBeGreaterThan(0);
    }
    expect(
      isEngineeringArtifactKindAllowedForStage(EngineeringStage.GATE_EXECUTION, "EvidenceBundle"),
    ).toBe(true);
    expect(
      isEngineeringArtifactKindAllowedForStage(EngineeringStage.GATE_EXECUTION, "SliceContract"),
    ).toBe(false);

    const cap = normalizeEngineeringWritePathAllowlist(["src/lib", "src", "src"]);
    expect(cap).toEqual(["src", "src/lib"]);
    expect(Object.isFrozen(cap)).toBe(true);
    expect(assertEngineeringPathsWithinWriteAllowlist(["src/a.ts"], ["src"])).toEqual(["src/a.ts"]);
    expect(() => assertEngineeringPathsWithinWriteAllowlist(["src2/a.ts"], ["src"])).toThrow(
      /outside.*allowlist/,
    );
  });

  it("normalizes, freezes and digests the strict server-owned write authorization scope", () => {
    const scope = normalizeEngineeringWriteAuthorizationScope({
      schema_version: 1,
      purpose: "ENGINEERING_WORKFLOW_WRITE",
      case_id: "case",
      owner_id: "owner",
      checkpoint_revision: 3,
      work_unit_id: "unit",
      run_id: "run",
      process_class: "LARGE_OR_HIGH_RISK",
      authoritative_scope: {
        connection_ids: ["connection-b", "connection-a", "connection-a"],
        repo_allowlist: ["repo-b", "repo-a"],
        can_write_workspace: true,
      },
    });
    expect(scope.authoritative_scope.connection_ids).toEqual(["connection-a", "connection-b"]);
    expect(scope.authoritative_scope.repo_allowlist).toEqual(["repo-a", "repo-b"]);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.authoritative_scope)).toBe(true);
    expect(Object.isFrozen(scope.authoritative_scope.connection_ids)).toBe(true);
    expect(engineeringWriteAuthorizationScopeDigest(scope)).toBe(canonicalDigest(scope));
    expect(engineeringWriteAuthorizationScopeDigest(scope)).toBe(
      engineeringWriteAuthorizationScopeDigest({
        ...scope,
        authoritative_scope: {
          ...scope.authoritative_scope,
          connection_ids: ["connection-b", "connection-a"],
        },
      }),
    );
    expect(() => engineeringWriteAuthorizationScopeV1.parse({ ...scope, digest })).toThrow();
    for (const key of [
      "purpose",
      "case_id",
      "owner_id",
      "checkpoint_revision",
      "work_unit_id",
      "run_id",
      "process_class",
      "authoritative_scope",
    ] as const) {
      const missing = { ...scope } as Record<string, unknown>;
      delete missing[key];
      expect(() => engineeringWriteAuthorizationScopeDigest(missing)).toThrow();
    }
    for (const key of ["connection_ids", "repo_allowlist", "can_write_workspace"] as const) {
      const authoritativeScope = { ...scope.authoritative_scope } as Record<string, unknown>;
      delete authoritativeScope[key];
      expect(() =>
        engineeringWriteAuthorizationScopeDigest({
          ...scope,
          authoritative_scope: authoritativeScope,
        }),
      ).toThrow();
    }
  });

  it("binds a V2 write grant and proposal to the normalized deployment path ceiling", () => {
    const deploymentPolicy = normalizeEngineeringWriteDeploymentPolicyV1({
      schema_version: 1,
      purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY",
      repository_id: "repo",
      write_path_allowlist: ["src/lib", "src", "src"],
    });
    expect(deploymentPolicy.write_path_allowlist).toEqual(["src", "src/lib"]);
    expect(engineeringWriteDeploymentPolicyV1Digest(deploymentPolicy)).toBe(
      canonicalDigest(deploymentPolicy),
    );
    expect(() =>
      engineeringWriteDeploymentPolicyV1.parse({
        ...deploymentPolicy,
        write_path_allowlist: ["src/lib", "src"],
      }),
    ).toThrow(/unique and sorted/);

    const scope = normalizeEngineeringWriteAuthorizationScopeV2({
      schema_version: 2,
      purpose: "ENGINEERING_WORKFLOW_WRITE",
      case_id: "case",
      owner_id: "owner",
      checkpoint_revision: 3,
      work_unit_id: "unit",
      run_id: "run",
      process_class: "LARGE_OR_HIGH_RISK",
      authoritative_scope: {
        connection_ids: [],
        repo_allowlist: ["repo"],
        can_write_workspace: true,
      },
      repository_id: "repo",
      write_path_allowlist: ["src/lib", "src", "src"],
      deployment_policy_digest: engineeringWriteDeploymentPolicyV1Digest(deploymentPolicy),
    });
    expect(scope.write_path_allowlist).toEqual(["src", "src/lib"]);
    expect(Object.isFrozen(scope.write_path_allowlist)).toBe(true);
    expect(engineeringWriteAuthorizationScopeV2Digest(scope)).toBe(canonicalDigest(scope));
    const narrowerDeploymentPolicy = normalizeEngineeringWriteDeploymentPolicyV1({
      ...deploymentPolicy,
      write_path_allowlist: ["src/lib"],
    });
    expect(engineeringWriteAuthorizationScopeV2Digest(scope)).not.toBe(
      engineeringWriteAuthorizationScopeV2Digest({
        ...scope,
        write_path_allowlist: ["src/lib"],
        deployment_policy_digest:
          engineeringWriteDeploymentPolicyV1Digest(narrowerDeploymentPolicy),
      }),
    );
    expect(() =>
      engineeringWriteAuthorizationScopeV2Digest({
        ...scope,
        deployment_policy_digest: engineeringWriteDeploymentPolicyV1Digest({
          ...deploymentPolicy,
          write_path_allowlist: ["src/lib"],
        }),
      }),
    ).toThrow(/deployment_policy_digest/);
    expect(() =>
      engineeringWriteAuthorizationScopeV2.parse({
        ...scope,
        authoritative_scope: { ...scope.authoritative_scope, repo_allowlist: ["other"] },
      }),
    ).toThrow(/repository_id/);

    const proposal = {
      schema_version: 1,
      proposal_id: "proposal",
      objective: "Implement the bounded case change",
      authorization_scope: scope,
      action_digest: engineeringWriteAuthorizationScopeV2Digest(scope),
      expires_at: "2026-08-26T12:00:00.000Z",
    };
    expect(engineeringWriteProposalV1.parse(proposal)).toEqual(proposal);
    expect(() =>
      engineeringWriteProposalV1.parse({
        ...proposal,
        action_digest: "sha256:" + "c".repeat(64),
      }),
    ).toThrow(/action_digest/);
    expect(() => engineeringWriteProposalV1.parse({ ...proposal, option_id: "grant" })).toThrow();
    expect(() => engineeringWriteProposalV1.parse({ ...proposal, objective: "   " })).toThrow(
      /blank/,
    );
  });

  it("strictly validates every standalone boundary without type coercion", () => {
    const binding = { schema_version: 1, case_id: "c", run_id: "r", revision: 0 };
    const source = {
      source_id: "source",
      kind: "RAW_EVIDENCE",
      ref: "source-ref",
      revision: 1,
      observed_at: "2026-01-01T00:00:00Z",
      digest,
      trust: "TRUSTED",
      freshness: "current",
      inclusion_reason: "required by the stage",
      byte_budget: 32,
      full_artifact_ref: "artifact-ref",
    };
    const decision = { ...binding, decision_id: "decision", rationale: "evidence-bound" };
    const boundaries: Array<{
      name: string;
      schema: { safeParse: (input: unknown) => { success: boolean } };
      payload: Record<string, unknown>;
    }> = [
      {
        name: "OutcomeContract",
        schema: engineeringOutcomeContract,
        payload: {
          ...binding,
          artifact_kind: "OutcomeContract",
          problem: "problem",
          outcome: "outcome",
          non_goals: [],
          objective: "objective",
          success_criteria: ["observable success"],
          constraints: [],
          process_class: "SMALL",
          source_digest: digest,
        },
      },
      {
        name: "SystemDesign",
        schema: engineeringSystemDesign,
        payload: {
          ...binding,
          artifact_kind: "SystemDesign",
          boundaries: ["contracts"],
          data: ["versioned JSON"],
          api: ["strict parser"],
          integrations: [],
          invariants: ["one control plane"],
          architecture: "SupervisorRuntime owns transitions",
          components: ["contracts"],
          interfaces: ["schema registry"],
          data_flow: "model proposal -> deterministic validation",
          risks: [],
          source_digest: digest,
        },
      },
      { name: "ProgramDesign", schema: engineeringProgramDesign, payload: program },
      {
        name: "SliceContract",
        schema: engineeringSliceContract,
        payload: {
          ...binding,
          artifact_kind: "SliceContract",
          slice_id: "slice",
          objective: "objective",
          observable_result: "one observable result",
          allowed_paths: ["src/a.ts"],
          gate_ids: ["gate.unit"],
          inspection_method: "inspect the receipt",
          stop_condition: "receipt is bound to the current tree",
        },
      },
      {
        name: "ContextManifest",
        schema: engineeringContextManifest,
        payload: {
          ...binding,
          artifact_kind: "ContextManifest",
          authority: "SERVER_OWNED",
          sources: [source],
          total_byte_budget: 32,
        },
      },
      {
        name: "EvidenceBundle",
        schema: engineeringEvidenceBundle,
        payload: {
          ...binding,
          artifact_kind: "EvidenceBundle",
          authority: "SERVER_OWNED",
          tree_digest: digest,
          config_digests: [digest],
          command_receipts: ["receipt"],
          diff_digest: digest,
          review_findings: [],
          decisions: [],
          items: [{ kind: "test", digest, summary: "passed", trust: "TRUSTED" }],
          context_digest: digest,
          test_first_evidence: [],
        },
      },
      {
        name: "SliceImplementationReceipt",
        schema: engineeringSliceImplementationReceipt,
        payload: {
          ...binding,
          artifact_kind: "SliceImplementationReceipt",
          authority: "SERVER_OWNED",
          receipt_id: "implementation-receipt",
          work_unit_id: "work-unit",
          slice_id: "slice",
          attempt: 1,
          workspace_id: "workspace",
          repository_id: "repo",
          base_sha: "a".repeat(40),
          branch: "remoteagent/workspace",
          baseline: {
            baseline_id: `slice-baseline-${"b".repeat(64)}`,
            tree_digest: digest,
          },
          tree_digest: digest,
          diff_digest: digest,
          raw_patch_digest: digest,
          changed_paths: ["src/a.ts"],
          cumulative_paths: ["src/a.ts"],
          files_changed: 1,
          insertions: 1,
          deletions: 0,
          tool_receipt_digests: [digest],
        },
      },
      {
        name: "MemoryUpdate",
        schema: engineeringMemoryUpdate,
        payload: {
          ...binding,
          artifact_kind: "MemoryUpdate",
          source_watermark: digest,
          evidence_digests: [digest],
          trust: "UNTRUSTED_DATA",
          authority: "MODEL_PROJECTION",
          completed_requirements: ["criterion-1"],
          open_issues: [],
        },
      },
      {
        name: "DesignDecision",
        schema: engineeringDesignDecision,
        payload: {
          ...decision,
          artifact_kind: "DesignDecision",
          decision: "APPROVE",
          artifact_digest: digest,
          findings: [],
          required_changes: [],
        },
      },
      {
        name: "ReviewDecision",
        schema: engineeringReviewDecision,
        payload: {
          ...decision,
          artifact_kind: "ReviewDecision",
          decision: "PASS",
          findings: [],
          reviewed_digest: digest,
        },
      },
      {
        name: "VerificationDecision",
        schema: engineeringVerificationDecision,
        payload: {
          ...decision,
          artifact_kind: "VerificationDecision",
          decision: "VERIFIED",
          criterion_outcomes: [
            { criterion_id: "criterion-1", status: "PASSED", evidence_digest: digest },
          ],
          evidence_digest: digest,
        },
      },
      {
        name: "LocalCommitReceipt",
        schema: engineeringLocalCommitReceipt,
        payload: {
          ...binding,
          artifact_kind: "LocalCommitReceipt",
          authority: "SERVER_OWNED",
          receipt_id: "commit-receipt",
          branch: "remoteagent/case-1",
          commit_sha: "a".repeat(40),
          parent_sha: "b".repeat(40),
          tree_digest: digest,
          diff_digest: digest,
          evidence_digest: digest,
          review_digest: digest,
          verification_decision_digest: digest,
        },
      },
      {
        name: "TerminalReason",
        schema: engineeringTerminalReason,
        payload: {
          ...binding,
          artifact_kind: "TerminalReason",
          reason: "COMPLETED",
          detail: "all criteria verified",
        },
      },
    ];

    for (const { name, schema, payload } of boundaries) {
      expect(schema.safeParse(payload).success, `${name} valid fixture`).toBe(true);
      expect(schema.safeParse({ ...payload, unexpected: true }).success, `${name} strict`).toBe(
        false,
      );
      expect(schema.safeParse({ ...payload, revision: "0" }).success, `${name} no coercion`).toBe(
        false,
      );
      expect(
        schema.safeParse({ ...payload, artifact_kind: "WrongArtifact" }).success,
        `${name} literal kind`,
      ).toBe(false);
    }
  });

  it("keeps local commit evidence strict and server-owned", () => {
    const receipt = {
      schema_version: 1,
      artifact_kind: "LocalCommitReceipt",
      case_id: "c",
      run_id: "r",
      revision: 0,
      authority: "SERVER_OWNED",
      receipt_id: "receipt-1",
      branch: "remoteagent/case-1",
      commit_sha: "a".repeat(40),
      parent_sha: "b".repeat(40),
      tree_digest: digest,
      diff_digest: digest,
      evidence_digest: digest,
      review_digest: digest,
      verification_decision_digest: digest,
    };
    expect(engineeringLocalCommitReceipt.safeParse(receipt).success).toBe(true);
    const withoutReviewDigest: Partial<typeof receipt> = { ...receipt };
    delete withoutReviewDigest.review_digest;
    expect(engineeringLocalCommitReceipt.safeParse(withoutReviewDigest).success).toBe(false);
    expect(
      engineeringLocalCommitReceipt.safeParse({ ...receipt, authority: "MODEL" }).success,
    ).toBe(false);
    expect(
      engineeringLocalCommitReceipt.safeParse({ ...receipt, commit_sha: "not-a-sha" }).success,
    ).toBe(false);
    expect(
      engineeringLocalCommitReceipt.safeParse({ ...receipt, commit_sha: "a".repeat(64) }).success,
    ).toBe(false);
    expect(
      engineeringLocalCommitReceipt.safeParse({ ...receipt, branch: "../escape" }).success,
    ).toBe(false);
  });

  it("requires every program-design planning dimension and is strict", () => {
    expect(engineeringProgramDesign.safeParse(program).success).toBe(true);
    expect(engineeringProgramDesign.safeParse({ ...program, unexpected: true }).success).toBe(
      false,
    );
    expect(engineeringProgramDesign.safeParse({ ...program, expected_tests: "test" }).success).toBe(
      false,
    );
    expect(engineeringProgramDesign.safeParse({ ...program, uncertainty_review: [] }).success).toBe(
      false,
    );
    expect(
      engineeringProgramDesign.safeParse({ ...program, slice_order: ["slice-1", "slice-1"] })
        .success,
    ).toBe(false);
  });

  it("keeps slices to gates and an observable result, never a raw command", () => {
    const slice = {
      schema_version: 1,
      artifact_kind: "SliceContract",
      case_id: "c",
      run_id: "r",
      revision: 0,
      slice_id: "s",
      objective: "o",
      observable_result: "one result",
      allowed_paths: ["src/a.ts"],
      gate_ids: ["RA-037.gate"],
      inspection_method: "inspect evidence",
      stop_condition: "when verified",
    };
    expect(engineeringSliceContract.safeParse(slice).success).toBe(true);
    expect(engineeringSliceContract.safeParse({ ...slice, gate_ids: ["pnpm test"] }).success).toBe(
      false,
    );
    expect(
      engineeringSliceContract.safeParse({ ...slice, inspection_method: "pnpm test" }).success,
    ).toBe(false);
  });

  it("enforces server-owned minimum process class", () => {
    expect(engineeringMinimumProcessClass(risk())).toBe("SMALL");
    expect(engineeringMinimumProcessClass(risk({ multi_module: true }))).toBe("MEDIUM");
    expect(engineeringMinimumProcessClass(risk({ migration: true }))).toBe("LARGE_OR_HIGH_RISK");
    expect(() => assertEngineeringProcessClassAllowed("SMALL", risk({ migration: true }))).toThrow(
      "below",
    );
    expect(
      assertEngineeringProcessClassAllowed("LARGE_OR_HIGH_RISK", risk({ migration: true })),
    ).toBe("LARGE_OR_HIGH_RISK");
    expect(() => engineeringMinimumProcessClass({ ...risk(), authority: "MODEL" })).toThrow();
    expect(() => assertEngineeringProcessClassAllowed("small", risk())).toThrow();
  });

  it("promotes every high-risk fact to LARGE and medium facts to MEDIUM", () => {
    for (const field of [
      "security_or_policy",
      "migration",
      "irreversible_side_effect",
      "broad_public_contract_change",
      "user_data",
      "concurrency",
      "external_side_effect",
    ] as const)
      expect(engineeringMinimumProcessClass(risk({ [field]: true }))).toBe("LARGE_OR_HIGH_RISK");
    for (const field of ["multi_module", "new_architecture"] as const)
      expect(engineeringMinimumProcessClass(risk({ [field]: true }))).toBe("MEDIUM");
    expect(engineeringMinimumProcessClass(risk({ deterministic_oracle: false }))).toBe("MEDIUM");
  });

  it("defines EngineeringPhase as a strict durable projection boundary", () => {
    const phase = {
      schema_version: 1,
      artifact_kind: "EngineeringPhase",
      case_id: "c",
      run_id: "r",
      revision: 0,
      stage: "SLICE_PLANNING",
      process_class: "SMALL",
      checkpoint_revision: 2,
      stage_attempt: 1,
      active_slice_id: null,
      context_manifest_digest: digest,
      artifact_digests: [digest],
    };
    expect(engineeringPhase.safeParse(phase).success).toBe(true);
    expect(
      engineeringPhase.safeParse({ ...phase, artifact_kind: "EngineeringOutcomeContract" }).success,
    ).toBe(false);
    expect(engineeringPhase.safeParse({ ...phase, stage_attempt: "1" }).success).toBe(false);
    expect(engineeringPhase.safeParse({ ...phase, transition: "NEXT" }).success).toBe(false);
  });

  it("binds context sources, trust and total byte budget", () => {
    const source = {
      source_id: "s",
      kind: "RAW_EVIDENCE",
      ref: "ref",
      revision: 1,
      observed_at: "2026-01-01T00:00:00Z",
      digest,
      trust: "TRUSTED",
      freshness: "current",
      inclusion_reason: "needed",
      byte_budget: 5,
      full_artifact_ref: "artifact",
    };
    expect(
      engineeringContextManifest.safeParse({
        schema_version: 1,
        artifact_kind: "ContextManifest",
        case_id: "c",
        run_id: "r",
        revision: 0,
        authority: "SERVER_OWNED",
        sources: [source],
        total_byte_budget: 5,
      }).success,
    ).toBe(true);
    expect(
      engineeringContextManifest.safeParse({
        schema_version: 1,
        artifact_kind: "ContextManifest",
        case_id: "c",
        run_id: "r",
        revision: 0,
        authority: "SERVER_OWNED",
        sources: [source, { ...source, source_id: "s" }],
        total_byte_budget: 10,
      }).success,
    ).toBe(false);
    expect(
      engineeringContextManifest.safeParse({
        schema_version: 1,
        artifact_kind: "ContextManifest",
        case_id: "c",
        run_id: "r",
        revision: 0,
        authority: "SERVER_OWNED",
        sources: [source],
        total_byte_budget: 4,
      }).success,
    ).toBe(false);
    expect(
      engineeringContextManifest.safeParse({
        schema_version: 1,
        artifact_kind: "ContextManifest",
        case_id: "c",
        run_id: "r",
        revision: 0,
        authority: "MODEL_PROJECTION",
        sources: [source],
        total_byte_budget: 5,
      }).success,
    ).toBe(false);
    expect(
      engineeringContextManifest.safeParse({
        schema_version: 1,
        artifact_kind: "ContextManifest",
        case_id: "c",
        run_id: "r",
        revision: 0,
        authority: "SERVER_OWNED",
        sources: [{ ...source, kind: "WORKING_PROJECTION", trust: "TRUSTED" }],
        total_byte_budget: 5,
      }).success,
    ).toBe(false);
  });

  it("keeps memory projection untrusted and evidence server-owned", () => {
    const memory = {
      schema_version: 1,
      artifact_kind: "MemoryUpdate",
      case_id: "c",
      run_id: "r",
      revision: 0,
      source_watermark: digest,
      evidence_digests: [digest],
      authority: "MODEL_PROJECTION",
      trust: "UNTRUSTED_DATA",
      completed_requirements: ["r1"],
      open_issues: ["none"],
    };
    expect(engineeringMemoryUpdate.safeParse(memory).success).toBe(true);
    expect(engineeringMemoryUpdate.safeParse({ ...memory, operation: "UPSERT" }).success).toBe(
      false,
    );
    expect(
      engineeringMemoryUpdate.safeParse({ ...memory, authority: "SERVER_OWNED" }).success,
    ).toBe(false);
    const evidence = {
      schema_version: 1,
      artifact_kind: "EvidenceBundle",
      case_id: "c",
      run_id: "r",
      revision: 0,
      authority: "SERVER_OWNED",
      tree_digest: digest,
      config_digests: [digest],
      command_receipts: ["receipt"],
      diff_digest: digest,
      review_findings: [],
      decisions: [],
      items: [{ kind: "test", digest, summary: "ok", trust: "TRUSTED" }],
      context_digest: digest,
      test_first_evidence: [],
    };
    expect(engineeringEvidenceBundle.safeParse(evidence).success).toBe(true);
    expect(engineeringEvidenceBundle.safeParse({ ...evidence, complete: true }).success).toBe(
      false,
    );
    expect(
      engineeringEvidenceBundle.safeParse({
        ...evidence,
        test_first_evidence: [
          {
            gate_id: "gate",
            baseline_tree_digest: digest,
            current_tree_digest: digest,
            baseline_outcome: "FAILED",
            current_outcome: "PASSED",
            receipt_ids: ["r1"],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      engineeringEvidenceBundle.safeParse({
        ...evidence,
        test_first_evidence: [
          {
            gate_id: "gate",
            baseline_tree_digest: digest,
            current_tree_digest: digest,
            baseline_outcome: "FAILED",
            current_outcome: "PASSED",
            receipt_ids: ["r1", "r2"],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("enforces decision semantics and terminal vocabulary", () => {
    const common = {
      schema_version: 1,
      case_id: "c",
      run_id: "r",
      revision: 0,
      decision_id: "d",
      rationale: "why",
    };
    expect(
      engineeringDesignDecision.safeParse({
        ...common,
        artifact_kind: "DesignDecision",
        artifact_digest: digest,
        decision: "APPROVE",
        findings: [],
        required_changes: [],
      }).success,
    ).toBe(true);
    expect(
      engineeringDesignDecision.safeParse({
        ...common,
        artifact_kind: "DesignDecision",
        artifact_digest: digest,
        decision: "REQUEST_CHANGES",
        findings: ["f"],
        required_changes: ["fix"],
      }).success,
    ).toBe(true);
    expect(
      engineeringDesignDecision.safeParse({
        ...common,
        artifact_kind: "DesignDecision",
        artifact_digest: digest,
        decision: "APPROVE",
        findings: ["f"],
        required_changes: [],
      }).success,
    ).toBe(false);
    expect(
      engineeringReviewDecision.safeParse({
        ...common,
        artifact_kind: "ReviewDecision",
        decision: "PASS",
        findings: [],
        reviewed_digest: digest,
      }).success,
    ).toBe(true);
    const criteria = [{ criterion_id: "c1", status: "PASSED", evidence_digest: digest }];
    expect(
      engineeringVerificationDecision.safeParse({
        ...common,
        artifact_kind: "VerificationDecision",
        decision: "VERIFIED",
        criterion_outcomes: criteria,
        evidence_digest: digest,
      }).success,
    ).toBe(true);
    expect(
      engineeringVerificationDecision.safeParse({
        ...common,
        artifact_kind: "VerificationDecision",
        decision: "VERIFIED",
        criterion_outcomes: [{ ...criteria[0], status: "FAILED" }],
        evidence_digest: digest,
      }).success,
    ).toBe(false);
    for (const reason of [
      "COMPLETED",
      "CANCELLED",
      "BLOCKED",
      "FAILED",
      "AMBIGUOUS",
      "NEEDS_CLARIFICATION",
      "EXHAUSTED",
      "BASELINE_FAILED",
    ])
      expect(
        engineeringTerminalReason.safeParse({
          schema_version: 1,
          artifact_kind: "TerminalReason",
          case_id: "c",
          run_id: "r",
          revision: 0,
          reason,
          detail: "detail",
        }).success,
      ).toBe(true);
  });

  it("strict-parses artifact before digesting and binds schema version", () => {
    expect(engineeringArtifact.parse(program).artifact_kind).toBe("ProgramDesign");
    expect(engineeringArtifactDigest(program)).toBe(
      engineeringArtifactDigest({ ...program, source_digest: digest }),
    );
    expect(() => engineeringArtifactDigest({ ...program, schema_version: 2 })).toThrow();
    expect(() => engineeringArtifactDigest({ ...program, unknown: true })).toThrow();
    expect(() =>
      engineeringArtifact.parse({ ...program, artifact_kind: "SystemDesign" }),
    ).toThrow();
    expect(engineeringProgramDesign.safeParse({ ...program, revision: "0" }).success).toBe(false);
    const reordered = Object.fromEntries(Object.entries(program).reverse());
    expect(engineeringArtifactDigest(program)).toBe(engineeringArtifactDigest(reordered));
  });
});
