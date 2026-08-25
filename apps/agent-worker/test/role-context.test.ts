/**
 * RA-032 WU-04: createRole feeds the case conversation to the model as UNTRUSTED context, as a
 * separate turn from the trusted objective. FakeTransport captures the request before it errors on
 * an exhausted script, so we assert exactly what reaches the model without a live call.
 */
import { expect, it } from "vitest";
import { FakeTransport } from "@remoteagent/bedrock-runtime";

import { createRole, roleConfigFromEnv } from "../src/roles.js";

const config = roleConfigFromEnv({ RA_MODEL_ID: "test-model" } as NodeJS.ProcessEnv);

function textOf(transport: FakeTransport): string {
  return transport.requests[0]!.messages.flatMap((m) => m.content)
    .map((c) => (c as { text?: string }).text ?? "")
    .join("\n");
}

it("sends the objective plus the UNTRUSTED case conversation as a separate turn", async () => {
  const transport = new FakeTransport([]); // empty script: converse captures, then throws
  const role = createRole({
    transport,
    config,
    readCaseMessages: async () => [{ role: "OWNER", body: "please retry the failing test" }],
  });
  await role
    .invoke({
      unit: {
        workUnit: { objective: "Reply to the owner", role: "SUPERVISOR", case_id: "case-1" },
      },
      run: { runId: "run-1" },
    })
    .catch(() => undefined);

  expect(transport.requests[0]!.messages).toHaveLength(2); // objective + untrusted context
  const text = textOf(transport);
  expect(text).toContain("Reply to the owner"); // trusted objective
  expect(text).toContain("please retry the failing test"); // untrusted owner message
  expect(text).toContain("UNTRUSTED"); // explicitly delimited as data, not instructions
  // The run/case binding is prepended so the model echoes matching ids in its completion.
  expect(text).toContain("case-1");
  expect(text).toContain("run-1");
  // The conversational directive must reach the model (no system-prompt channel exists), or the
  // model writes third-person reports into `summary` instead of a direct reply.
  expect(text).toContain("summary");
  expect(text.toLowerCase()).toContain("first-person");
});

it("sends only the objective when there is no conversation (or no reader)", async () => {
  const withEmpty = new FakeTransport([]);
  const role = createRole({ transport: withEmpty, config, readCaseMessages: async () => [] });
  await role
    .invoke({
      unit: { workUnit: { objective: "X", role: "SUPERVISOR", case_id: "c" } },
      run: { runId: "run-1" },
    })
    .catch(() => undefined);
  expect(withEmpty.requests[0]!.messages).toHaveLength(1);

  const noReader = new FakeTransport([]);
  const role2 = createRole({ transport: noReader, config });
  await role2
    .invoke({
      unit: { workUnit: { objective: "Y", role: "SUPERVISOR", case_id: "c" } },
      run: { runId: "run-1" },
    })
    .catch(() => undefined);
  expect(noReader.requests[0]!.messages).toHaveLength(1);
});
