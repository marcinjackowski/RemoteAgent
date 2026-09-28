import {
  parseEngineeringPilotArgs,
  runEngineeringPilot,
  engineeringPilotStatus,
  stopEngineeringPilot,
} from "../../apps/agent-worker/src/engineering-pilot.js";

try {
  const options = parseEngineeringPilotArgs(process.argv.slice(2));
  if (options.command === "run") {
    process.stdout.write(
      JSON.stringify(
        await runEngineeringPilot(options, (record) => {
          process.stdout.write(
            JSON.stringify({
              outcome: "RUN_STARTED",
              run_id: record.run_id,
              case_id: record.case_id,
              run_dir: options.runDir,
            }) + "\n",
          );
        }),
      ) + "\n",
    );
  } else if (options.command === "status") {
    const result = await engineeringPilotStatus(options.runDir, options.runId!);
    process.stdout.write(
      JSON.stringify({
        run_id: result.record.run_id,
        case_id: result.record.case_id,
        current_stage: result.status?.current_stage ?? null,
        recovery_status: result.status?.recovery_status ?? null,
        cancellation_requested: result.status?.cancellation_requested ?? null,
      }) + "\n",
    );
  } else {
    const result = await stopEngineeringPilot(options.runDir, options.runId!);
    process.stdout.write(JSON.stringify({ status: result.status }) + "\n");
  }
} catch (error) {
  const code =
    error instanceof Error && /^E_[A-Z0-9_]+$/.test(error.message) ? error.message : "E_PILOT";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
