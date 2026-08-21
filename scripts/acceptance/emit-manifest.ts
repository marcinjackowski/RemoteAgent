/**
 * CLI to emit the release manifest (RA-026-WU-03).
 *
 * Separate from `./release-manifest.ts` so that module stays importable by tests without a
 * CLI side effect, and so the two genuinely varying inputs — the commit and the timestamp —
 * are supplied from the environment at the boundary rather than read anywhere inside.
 *
 * Usage:
 *   RA_COMMIT=$(git rev-parse HEAD) RA_GENERATED_AT=$(date -u +%FT%TZ) \
 *     tsx scripts/acceptance/emit-manifest.ts
 *
 * Both are REQUIRED. A default would make the manifest non-deterministic in exactly the way
 * that destroys its purpose (AC5): a manifest that differs between two runs on one commit
 * cannot verify a deployment, because any difference could be a real change or the tool.
 */
import { fileURLToPath } from "node:url";

import { partialCriteria } from "./criteria.ts";
import { buildReleaseManifest, renderManifest } from "./release-manifest.ts";
import { generateSbom } from "../security/sbom.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const commit = process.env.RA_COMMIT;
const generatedAt = process.env.RA_GENERATED_AT;
if (commit === undefined || generatedAt === undefined) {
  process.stderr.write(
    "RA_COMMIT and RA_GENERATED_AT are required; a default would make the manifest " +
      "non-deterministic and therefore useless for verifying a deployment\n",
  );
  process.exit(2);
}

const sbom = generateSbom(`${repoRoot}/pnpm-lock.yaml`);
process.stdout.write(
  renderManifest(
    buildReleaseManifest({
      commit,
      generatedAt,
      repoRoot,
      dependencyCount: sbom.components.length,
      lockfileVersion: sbom.lockfileVersion,
      // The gaps travel WITH the manifest. Somebody reproducing a version needs to know
      // what was not proven about it, without having to find a second document.
      knownGaps: partialCriteria().map(
        (entry) => `MP-13.${String(entry.number)}: ${entry.gap ?? ""}`,
      ),
    }),
  ),
);
