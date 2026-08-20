/**
 * `@remoteagent/connector-gitlab` — allowlisted GitLab reads, verified webhooks and
 * idempotent draft merge requests.
 *
 * Three properties are structural rather than conventional.
 *
 * A project outside the server-owned allowlist cannot be *named* in a call:
 * `GitLabProjectRef` is a branded type whose only producer is
 * `GitLabProjectAllowlist.resolve`, and every read and write API demands one. The
 * allowlist is therefore not a check a caller might forget — it is the only way to
 * obtain the argument.
 *
 * The credential has no resting place. No contract carries a token field,
 * `gitlabRemote` refuses a URL with userinfo (the `https://oauth2:TOKEN@host` shape
 * that leaks into `git remote -v` and into Git's own error text), and the broker
 * hands the value to a callback rather than exposing it as a property.
 *
 * Idempotency is established against the remote, not against local bookkeeping. A
 * local "already created" flag is precisely what a crash between the create call and
 * the flag write invalidates, so the publisher looks the MR up by its branch pair
 * every time.
 *
 * The former `packageName` skeleton export is gone: it was one of the six duplicate
 * `packageName` literals recorded in `CTF-002` as noise in the public API, and this
 * task owns the file.
 */
export * from "./contracts.js";
export * from "./webhook.js";
export * from "./merge-request.js";
