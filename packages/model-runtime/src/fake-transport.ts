import { TransportError } from "./errors.js";
import type { RuntimeConfig, RuntimeRequest, RuntimeResponse, RuntimeTransport } from "./types.js";

function copyRequest(request: RuntimeRequest): RuntimeRequest {
  const copy: RuntimeRequest = {
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content.map((content) => ({ ...content })),
    })),
  };
  if (request.signal !== undefined) return { ...copy, signal: request.signal };
  return copy;
}

/** A deterministic, credential-free transport for runtime tests. */
export class FakeTransport implements RuntimeTransport {
  private readonly scriptedResponses: readonly RuntimeResponse[];
  private responseIndex = 0;
  private readonly capturedRequests: RuntimeRequest[] = [];

  constructor(scriptedResponses: readonly RuntimeResponse[]) {
    this.scriptedResponses = scriptedResponses.map((response) => ({
      ...response,
      content: response.content.map((content) => ({ ...content })),
    }));
  }

  get requests(): readonly RuntimeRequest[] {
    return this.capturedRequests;
  }

  getRequests(): readonly RuntimeRequest[] {
    return this.requests;
  }

  async converse(request: RuntimeRequest, _config: RuntimeConfig): Promise<RuntimeResponse> {
    this.capturedRequests.push(copyRequest(request));
    const response = this.scriptedResponses[this.responseIndex];
    if (response === undefined) {
      throw new TransportError("Fake transport script is exhausted");
    }
    this.responseIndex += 1;
    return {
      ...response,
      content: response.content.map((content) => ({ ...content })),
    };
  }
}
