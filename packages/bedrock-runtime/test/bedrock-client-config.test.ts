/**
 * RA-032 WU-02: bedrockClientConfig wires Bedrock API key (bearer) auth. A bearerToken becomes the
 * client `token` (httpBearerAuth, no IAM keys); its absence leaves the SDK's default SigV4 chain.
 */
import { describe, expect, it } from "vitest";

import { bedrockClientConfig } from "../src/aws-transport.js";

describe("bedrockClientConfig", () => {
  it("leaves the default credential chain when no bearer token is given", () => {
    expect(bedrockClientConfig({})).toEqual({});
    expect(bedrockClientConfig({ region: "us-east-1" })).toEqual({ region: "us-east-1" });
  });

  it("selects bearer auth by setting the client token when a bearer token is given", () => {
    expect(bedrockClientConfig({ bearerToken: "bedrock-api-key" })).toEqual({
      token: { token: "bedrock-api-key" },
    });
    expect(bedrockClientConfig({ region: "eu-west-1", bearerToken: "k" })).toEqual({
      region: "eu-west-1",
      token: { token: "k" },
    });
  });

  it("treats an empty bearer token as unset (default chain, not a broken token)", () => {
    expect(bedrockClientConfig({ bearerToken: "" })).toEqual({});
  });
});
