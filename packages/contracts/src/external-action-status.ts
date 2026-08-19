/**
 * External-action status enum, factored out so the status machine and the
 * contract schema can both import it without a circular dependency.
 */
import * as z from "zod";

export const ExternalActionStatus = {
  PROPOSED: "PROPOSED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  EXECUTING: "EXECUTING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  /** Write could not be reconciled with the external system after a restart. */
  AMBIGUOUS: "AMBIGUOUS",
} as const;

export type ExternalActionStatus = (typeof ExternalActionStatus)[keyof typeof ExternalActionStatus];

export const externalActionStatusSchema = z.enum([
  ExternalActionStatus.PROPOSED,
  ExternalActionStatus.APPROVED,
  ExternalActionStatus.REJECTED,
  ExternalActionStatus.EXECUTING,
  ExternalActionStatus.SUCCEEDED,
  ExternalActionStatus.FAILED,
  ExternalActionStatus.AMBIGUOUS,
]);
