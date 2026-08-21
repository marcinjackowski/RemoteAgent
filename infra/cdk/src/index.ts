/**
 * `@remoteagent/infra-cdk` — AWS environments as code (RA-025).
 *
 * `synth` requires NO AWS credentials and NO network: every stack states its account and
 * region explicitly, and nothing reads a clock, a random source or the environment. That
 * is what makes AC1 ("synth/diff is deterministic and passes security policy checks")
 * verifiable on a developer machine rather than only in CI — measured, not assumed:
 *
 *     AWS_PROFILE= AWS_ACCESS_KEY_ID= AWS_SECRET_ACCESS_KEY= tsx probe.ts  → exit 0
 *
 * No container image is built here. Docker is broken on this machine (`AGENTS.md`), so a
 * `DockerImageAsset` would make synth fail; images are referenced by repository and tag,
 * which is also the better deployment shape — a build and a deploy become separate steps.
 */
export * from "./config.js";
export * from "./app.js";
export * from "./network-stack.js";
export * from "./data-stack.js";
export * from "./queue-stack.js";
export * from "./compute-stack.js";
export * from "./ingress-stack.js";
export * from "./policy-checks.js";

/** Kept from the RA-001 skeleton; the eslint boundary rule refers to this package. */
export const infraName = "infra-cdk" as const;
