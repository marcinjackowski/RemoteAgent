import {
  AgentRole,
  EngineeringStage,
  type ContractName,
  type EngineeringProcessClass,
} from "@remoteagent/contracts";
export { EngineeringStage } from "@remoteagent/contracts";

/**
 * Engineering stages are durable domain payloads consumed by SupervisorRuntime.
 * They deliberately do not form an independently executable state machine.
 */
type RegistryEngineeringStage = import("@remoteagent/contracts").EngineeringStage;

export type EngineeringStageDefinition = Readonly<{
  role: (typeof AgentRole)[keyof typeof AgentRole];
  input_artifacts: readonly ContractName[];
  output_artifacts: readonly ContractName[];
  /** Structured model response; null means the stage output is assembled by system code. */
  completion_contract: ContractName | null;
  workspace_access: "READ_ONLY" | "WRITE";
}>;

const readOnly = "READ_ONLY" as const;
const artifacts = (...names: ContractName[]): readonly ContractName[] => Object.freeze(names);

/** Pure routing data. Runtime authority, queueing and transitions stay in SupervisorRuntime. */
export const engineeringStageRegistry = Object.freeze({
  [EngineeringStage.DISCOVERY]: Object.freeze({
    role: AgentRole.PLANNER,
    input_artifacts: artifacts("EngineeringContextManifest"),
    output_artifacts: artifacts(),
    completion_contract: null,
    workspace_access: readOnly,
  }),
  [EngineeringStage.OUTCOME_DEFINITION]: Object.freeze({
    role: AgentRole.PLANNER,
    input_artifacts: artifacts("EngineeringContextManifest"),
    output_artifacts: artifacts("EngineeringOutcomeContract"),
    completion_contract: "EngineeringOutcomeContract",
    workspace_access: readOnly,
  }),
  [EngineeringStage.SYSTEM_DESIGN]: Object.freeze({
    role: AgentRole.PLANNER,
    input_artifacts: artifacts("EngineeringContextManifest"),
    output_artifacts: artifacts("EngineeringSystemDesign"),
    completion_contract: "EngineeringSystemDesign",
    workspace_access: readOnly,
  }),
  [EngineeringStage.PROGRAM_DESIGN]: Object.freeze({
    role: AgentRole.PLANNER,
    input_artifacts: artifacts("EngineeringContextManifest", "EngineeringSystemDesign"),
    output_artifacts: artifacts("EngineeringProgramDesign"),
    completion_contract: "EngineeringProgramDesign",
    workspace_access: readOnly,
  }),
  [EngineeringStage.DESIGN_APPROVAL]: Object.freeze({
    role: AgentRole.REVIEWER,
    input_artifacts: artifacts(
      "EngineeringOutcomeContract",
      "EngineeringSystemDesign",
      "EngineeringProgramDesign",
    ),
    output_artifacts: artifacts("EngineeringDesignDecision"),
    completion_contract: "EngineeringDesignDecision",
    workspace_access: readOnly,
  }),
  [EngineeringStage.SLICE_PLANNING]: Object.freeze({
    role: AgentRole.PLANNER,
    input_artifacts: artifacts("EngineeringContextManifest"),
    output_artifacts: artifacts("EngineeringSliceContract"),
    completion_contract: "EngineeringSliceContract",
    workspace_access: readOnly,
  }),
  [EngineeringStage.SLICE_IMPLEMENTATION]: Object.freeze({
    role: AgentRole.IMPLEMENTER,
    input_artifacts: artifacts("EngineeringContextManifest", "EngineeringSliceContract"),
    output_artifacts: artifacts(),
    completion_contract: null,
    workspace_access: "WRITE",
  }),
  [EngineeringStage.GATE_EXECUTION]: Object.freeze({
    role: AgentRole.VERIFICATION,
    input_artifacts: artifacts("EngineeringSliceContract"),
    output_artifacts: artifacts("EngineeringEvidenceBundle"),
    completion_contract: null,
    workspace_access: readOnly,
  }),
  [EngineeringStage.SLICE_REVIEW]: Object.freeze({
    role: AgentRole.REVIEWER,
    input_artifacts: artifacts("EngineeringSliceContract", "EngineeringEvidenceBundle"),
    output_artifacts: artifacts("EngineeringReviewDecision"),
    completion_contract: "EngineeringReviewDecision",
    workspace_access: readOnly,
  }),
  [EngineeringStage.MEMORY_PROJECTION]: Object.freeze({
    role: AgentRole.PLANNER,
    input_artifacts: artifacts("EngineeringEvidenceBundle", "EngineeringReviewDecision"),
    output_artifacts: artifacts("EngineeringMemoryUpdate"),
    completion_contract: "EngineeringMemoryUpdate",
    workspace_access: readOnly,
  }),
  [EngineeringStage.FINAL_VERIFICATION]: Object.freeze({
    role: AgentRole.VERIFICATION,
    input_artifacts: artifacts("EngineeringEvidenceBundle", "EngineeringReviewDecision"),
    output_artifacts: artifacts("EngineeringVerificationDecision"),
    completion_contract: "EngineeringVerificationDecision",
    workspace_access: readOnly,
  }),
} satisfies Record<EngineeringStage, EngineeringStageDefinition>);

export type EngineeringProcessGraph = Readonly<{
  design_stages: readonly RegistryEngineeringStage[];
  slice_loop_stages: readonly RegistryEngineeringStage[];
  completion_stages: readonly RegistryEngineeringStage[];
}>;

const sliceLoopStages = Object.freeze([
  EngineeringStage.SLICE_PLANNING,
  EngineeringStage.SLICE_IMPLEMENTATION,
  EngineeringStage.GATE_EXECUTION,
  EngineeringStage.SLICE_REVIEW,
  EngineeringStage.MEMORY_PROJECTION,
]);

const completionStages = Object.freeze([EngineeringStage.FINAL_VERIFICATION]);

/** Risk-proportional blueprints interpreted by the existing SupervisorRuntime. */
export const engineeringProcessGraphs: Readonly<
  Record<EngineeringProcessClass, EngineeringProcessGraph>
> = Object.freeze({
  SMALL: Object.freeze({
    design_stages: Object.freeze([EngineeringStage.DISCOVERY]),
    slice_loop_stages: sliceLoopStages,
    completion_stages: completionStages,
  }),
  MEDIUM: Object.freeze({
    design_stages: Object.freeze([
      EngineeringStage.DISCOVERY,
      EngineeringStage.SYSTEM_DESIGN,
      EngineeringStage.PROGRAM_DESIGN,
    ]),
    slice_loop_stages: sliceLoopStages,
    completion_stages: completionStages,
  }),
  LARGE_OR_HIGH_RISK: Object.freeze({
    design_stages: Object.freeze([
      EngineeringStage.DISCOVERY,
      EngineeringStage.OUTCOME_DEFINITION,
      EngineeringStage.SYSTEM_DESIGN,
      EngineeringStage.PROGRAM_DESIGN,
      EngineeringStage.DESIGN_APPROVAL,
    ]),
    slice_loop_stages: sliceLoopStages,
    completion_stages: completionStages,
  }),
});
