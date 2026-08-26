# RA-040 — reply-loop context baseline

- Fixture: 28 case messages (25 filler, old lexical evidence, latest owner steering, post-cutoff
  message) plus pinned checkpoint and Jira receipt.
- Measurement: UTF-8 bytes; token footprint is explicitly an estimate `ceil(bytes / 4)`, never
  reported as provider usage.

| Path | Bytes | Estimated tokens |
|---|---:|---:|
| Full history | 4053 | 1014 |
| Legacy `listRecent(20)` rendering | 2935 | 734 |
| New compiled packet | 2764 | 691 |

The compiled packet retained the latest owner steering, the old lexically relevant message and Jira
issue context. It excluded post-cutoff data and did not replay the complete history.

Evidence command run on `2026-08-26`:

```text
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run test/context/ra-040-baseline.test.ts
exit 0; 1/1 test; RA040_BASELINE full_bytes=4053 legacy20_bytes=2935 new_bytes=2764
full_est=1014 legacy_est=734 new_est=691
```
