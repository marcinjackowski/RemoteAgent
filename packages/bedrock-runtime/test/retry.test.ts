import { describe, expect, it } from "vitest";

import { classifyTransportFailure } from "../src/retry.js";

describe("classifyTransportFailure", () => {
  it.each([
    [{ name: "ThrottlingException" }, "THROTTLING"],
    [{ code: "TooManyRequestsException" }, "THROTTLING"],
    [{ name: "ServiceError", statusCode: 429 }, "THROTTLING"],
    [{ name: "InternalServerException" }, "TRANSIENT"],
    [{ code: "ETIMEDOUT" }, "TRANSIENT"],
    [{ name: "ModelTimeoutException" }, "TRANSIENT"],
    [{ $metadata: { httpStatusCode: 503 } }, "TRANSIENT"],
    [{ statusCode: 408 }, "TRANSIENT"],
    [{ name: "AbortError" }, "CANCELLED"],
    [{ code: "CancelledError" }, "CANCELLED"],
    [{ name: "Error", code: "ETIMEDOUT" }, "TRANSIENT"],
    [{ name: "Error", code: "AbortError" }, "CANCELLED"],
    [{ statusCode: "not-a-status", httpStatusCode: 503 }, "TRANSIENT"],
    [{ name: "ValidationException", statusCode: 400 }, "FATAL"],
    [{ name: "ValidationException", message: "throttling" }, "FATAL"],
  ] as const)("classifies %j as %s", (error, kind) => {
    expect(classifyTransportFailure(error)).toBe(kind);
  });

  it("uses the AWS retryable trait without inspecting message text", () => {
    expect(classifyTransportFailure({ $retryable: {} })).toBe("TRANSIENT");
    expect(classifyTransportFailure({ $retryable: { throttling: true } })).toBe("THROTTLING");
    expect(classifyTransportFailure({ retryable: true, message: "fatal" })).toBe("TRANSIENT");
  });
});
