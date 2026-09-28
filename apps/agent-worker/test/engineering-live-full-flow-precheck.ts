/**
 * Source-only FAST precheck for the explicit full-flow profile.
 *
 * This intentionally proves presence in production source/resources only. It does not prove
 * rendering, action behavior, layout, or any Xcode execution outcome.
 */
export const FULL_FLOW_SOURCE_PRECHECK_SCRIPT = String.raw`
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const sourceRoot = join(process.cwd(), "SonderClientLibrary", "Sources", "Shared");

async function files(root, suffixes) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path, suffixes)));
    else if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      result.push(path);
    }
  }
  return result.sort();
}

async function readTree(root, suffixes) {
  const paths = await files(root, suffixes);
  return (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n");
}

const sources = await readTree(sourceRoot, [".swift", ".strings"]);
const requirements = new Map([
  ["generated help asset accessor", sources.includes('ImageAsset(name: "help"')],
  ["general heading", sources.includes("Help is available")],
  [
    "general body",
    [
      "Something you wrote suggested you might not be safe right now.",
      "Caring, trained counselors are ready to listen, for free, 24/7.",
      "They can help, whether or not things feel urgent.",
    ].every((value) => sources.includes(value)),
  ],
  ["sharing heading", sources.includes("This message was shared for safety reasons")],
  [
    "sharing body",
    [
      "Messages that raise a safety concern are automatically shared with your provider at SonderMind.",
      "In the meantime, caring, trained counselors are ready to listen and support you right now, for free, 24/7.",
    ].every((value) => sources.includes(value)),
  ],
  ["required actions", ["Text 988", "Emergency resources", "Close"].every((value) => sources.includes(value))],
]);
const missing = [...requirements].filter(([, satisfied]) => !satisfied).map(([name]) => name);
for (const name of missing) process.stderr.write("FULL_FLOW_SOURCE_PRECHECK missing: " + name + "\n");
process.exitCode = missing.length === 0 ? 0 : 1;
`;
