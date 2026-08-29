import { canonicalDigest, sha256Digest } from "@remoteagent/contracts";
import {
  subscriptionModelInvocationDescriptorV1,
  subscriptionModelRole,
} from "@remoteagent/model-runtime";
import * as z from "zod";

const relativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.startsWith("/") && !value.split(/[/\\]+/u).includes(".."));
const commitSha = z.string().regex(/^[0-9a-f]{40}$/u);

const qualificationUsage = z
  .object({
    role: subscriptionModelRole,
    invocation_digest: sha256Digest,
    responses: z.number().int().nonnegative(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    responses_without_usage: z.number().int().nonnegative(),
  })
  .strict();

const reportCore = z
  .object({
    schema_version: z.literal(1),
    scenario_digest: sha256Digest,
    outcome: z.enum(["SUCCEEDED", "FAILED", "REFUSED"]),
    routes: z
      .object({
        DESIGNER: subscriptionModelInvocationDescriptorV1,
        IMPLEMENTER: subscriptionModelInvocationDescriptorV1,
        REVIEWER: subscriptionModelInvocationDescriptorV1,
        VERIFIER: subscriptionModelInvocationDescriptorV1,
      })
      .strict(),
    gate_attempts: z.number().int().nonnegative(),
    review_attempts: z.number().int().nonnegative(),
    elapsed_ms: z.number().int().nonnegative(),
    usage: z.array(qualificationUsage).length(4),
    changed_paths: z.array(relativePath).max(512),
    diff_digest: sha256Digest.nullable(),
    commit_sha: commitSha.nullable(),
  })
  .strict()
  .superRefine((report, ctx) => {
    const roles = ["DESIGNER", "IMPLEMENTER", "REVIEWER", "VERIFIER"] as const;
    for (const role of roles) {
      if (report.routes[role].role !== role) {
        ctx.addIssue({ code: "custom", path: ["routes", role], message: "route role mismatch" });
      }
    }
    const usageRoles = report.usage.map((entry) => entry.role);
    if (
      usageRoles.some((role, index) => role !== roles[index]) ||
      new Set(usageRoles).size !== roles.length
    ) {
      ctx.addIssue({ code: "custom", path: ["usage"], message: "usage roles must be exact" });
    }
    for (const entry of report.usage) {
      if (entry.invocation_digest !== canonicalDigest(report.routes[entry.role])) {
        ctx.addIssue({
          code: "custom",
          path: ["usage", entry.role, "invocation_digest"],
          message: "usage invocation identity mismatch",
        });
      }
    }
    if (
      new Set(report.changed_paths).size !== report.changed_paths.length ||
      report.changed_paths.some(
        (path, index) => index > 0 && report.changed_paths[index - 1]! >= path,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["changed_paths"],
        message: "must be unique and sorted",
      });
    }
    if (
      report.outcome === "SUCCEEDED" &&
      (report.diff_digest === null || report.commit_sha === null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "successful report requires diff and commit identity",
      });
    }
    if (report.outcome !== "SUCCEEDED" && report.commit_sha !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["commit_sha"],
        message: "refused/failed run cannot commit",
      });
    }
  });

export const engineeringQualificationReportV1 = reportCore
  .extend({ report_digest: sha256Digest })
  .superRefine((report, ctx) => {
    const { report_digest: reportDigest, ...core } = report;
    if (reportDigest !== canonicalDigest(reportCore.parse(core))) {
      ctx.addIssue({
        code: "custom",
        path: ["report_digest"],
        message: "qualification report digest mismatch",
      });
    }
  });

export type EngineeringQualificationReportV1 = z.infer<typeof engineeringQualificationReportV1>;
export type EngineeringQualificationReportInput = z.input<typeof reportCore>;

/** Build a bounded comparison artifact. It accepts no prompt, prose, tool body or host path. */
export function createEngineeringQualificationReport(
  input: EngineeringQualificationReportInput,
): EngineeringQualificationReportV1 {
  const core = reportCore.parse(input);
  return engineeringQualificationReportV1.parse({
    ...core,
    report_digest: canonicalDigest(core),
  });
}
