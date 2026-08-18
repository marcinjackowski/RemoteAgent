// Deliberately broken fixture. It must FAIL `tsc` under the shared strict base
// config (noImplicitAny -> TS7006). The guardrails spec asserts this failure so
// a future relaxation of strictness is caught. Excluded from lint/typecheck/build.
export function echo(value) {
  return value;
}
