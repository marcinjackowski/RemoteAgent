import { access, lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
export type NetworkMode = "DENY" | "ALLOW";

export type ProcessRunnerErrorCode =
  | "INVALID_COMMAND"
  | "INVALID_ENVIRONMENT"
  | "NOT_ENFORCEABLE"
  | "TIMEOUT"
  | "RESOURCE_LIMIT"
  | "SPAWN_FAILED";

export class ProcessRunnerError extends Error {
  public constructor(
    public readonly code: ProcessRunnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProcessRunnerError";
  }
}

export type NetworkLaunch = Readonly<{ executable: string; args: readonly string[] }>;

export async function prepareNetworkLaunch(
  executable: string,
  args: readonly string[],
  workspaceRoot: string,
  mode: NetworkMode = "DENY",
): Promise<NetworkLaunch> {
  if (!isAbsolute(executable) || executable.includes("\0")) {
    throw new ProcessRunnerError("INVALID_COMMAND", "Executable must be an absolute path");
  }
  const canonicalExecutable = await realpath(executable).catch(() => {
    throw new ProcessRunnerError("INVALID_COMMAND", "Executable must exist");
  });
  const executableStat = await lstat(executable).catch(() => undefined);
  if (!executableStat?.isFile() || canonicalExecutable !== executable) {
    throw new ProcessRunnerError("INVALID_COMMAND", "Executable must be a canonical regular file");
  }
  if (process.platform !== "darwin") {
    throw new ProcessRunnerError(
      "NOT_ENFORCEABLE",
      "Workspace sandbox is not enforceable on this platform",
    );
  }
  try {
    await access("/usr/bin/sandbox-exec");
  } catch {
    throw new ProcessRunnerError("NOT_ENFORCEABLE", "sandbox-exec is unavailable");
  }
  const networkRule = mode === "DENY" ? "(deny network*)" : "(allow network*)";
  const profile = `(version 1)(import "system.sb")${networkRule}(deny file-read*)(allow file-read* (subpath (param "WORKSPACE_ROOT")) (subpath "/usr/lib") (subpath "/usr/bin") (subpath "/bin") (subpath "/System/Library") (subpath "/private/var/db/dyld") (literal (param "EXECUTABLE")))(deny file-write*)(allow file-write* (subpath (param "WORKSPACE_ROOT")))(allow process-fork)(allow process-exec (literal (param "EXECUTABLE")))`;
  return {
    executable: "/usr/bin/sandbox-exec",
    args: [
      "-D",
      `WORKSPACE_ROOT=${workspaceRoot}`,
      "-D",
      `EXECUTABLE=${executable}`,
      "-p",
      profile,
      executable,
      ...args,
    ],
  };
}
