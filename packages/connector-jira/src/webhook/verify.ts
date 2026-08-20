import { jwtVerify, type JWTPayload } from "jose";

import { JiraContractError } from "../errors.js";

export interface JiraWebhookVerifierOptions {
  getClientSecret: () => Promise<Uint8Array>;
  issuer?: string;
  audience?: string | string[];
}

export interface VerifiedJiraWebhookToken {
  claims: JWTPayload & { jti: string };
}

/** Verify Jira's OAuth dynamic-webhook bearer token without retaining secrets. */
export async function verifyJiraWebhookAuthorization(
  authorization: string | null | undefined,
  options: JiraWebhookVerifierOptions,
): Promise<VerifiedJiraWebhookToken> {
  if (typeof authorization !== "string" || !/^Bearer [^\s]+$/.test(authorization)) {
    throw new JiraContractError("missing bearer authorization");
  }
  const token = authorization.slice(7);
  let secret: Uint8Array | undefined;
  try {
    const leased = await options.getClientSecret();
    if (!(leased instanceof Uint8Array) || leased.byteLength === 0) {
      throw new JiraContractError("invalid webhook secret");
    }
    secret = new Uint8Array(leased);
    const verified = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
      ...(options.audience === undefined ? {} : { audience: options.audience }),
    });
    const { payload } = verified;
    if (
      typeof payload.iss !== "string" ||
      typeof payload.jti !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.iat) ||
      !Number.isFinite(payload.exp)
    ) {
      throw new JiraContractError("invalid webhook claims");
    }
    return { claims: payload as JWTPayload & { jti: string } };
  } catch (error) {
    if (error instanceof JiraContractError) throw error;
    throw new JiraContractError("invalid webhook authorization");
  } finally {
    if (secret !== undefined) secret.fill(0);
  }
}

export const verifyJiraWebhook = verifyJiraWebhookAuthorization;
