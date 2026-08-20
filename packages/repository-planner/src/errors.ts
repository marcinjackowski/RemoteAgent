export type InstructionDiscoveryErrorCode =
  | "INVALID_INSTRUCTION"
  | "INSTRUCTION_CONFLICT"
  | "SYMLINK_NOT_ALLOWED"
  | "INSTRUCTION_READ_FAILED"
  | "INSTRUCTION_OVERSIZE"
  | "INSTRUCTION_INCOMPLETE"
  | "INSTRUCTION_DIGEST_MISMATCH";

export class InstructionDiscoveryError extends Error {
  public constructor(
    public readonly code: InstructionDiscoveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InstructionDiscoveryError";
  }
}
