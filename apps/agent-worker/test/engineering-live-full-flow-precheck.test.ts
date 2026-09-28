import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { FULL_FLOW_SOURCE_PRECHECK_SCRIPT } from "./engineering-live-full-flow-precheck.js";

const exec = promisify(execFile);
const roots: string[] = [];

const requiredSource = [
  'ImageAsset(name: "help"',
  "Help is available",
  "Something you wrote suggested you might not be safe right now.",
  "Caring, trained counselors are ready to listen, for free, 24/7.",
  "They can help, whether or not things feel urgent.",
  "This message was shared for safety reasons",
  "Messages that raise a safety concern are automatically shared with your provider at SonderMind.",
  "In the meantime, caring, trained counselors are ready to listen and support you right now, for free, 24/7.",
  "Text 988",
  "Emergency resources",
  "Close",
];

async function fixture(missing?: string) {
  const root = await mkdtemp(join(tmpdir(), "ra055-full-flow-precheck-"));
  roots.push(root);
  const shared = join(root, "SonderClient", "SonderClientLibrary", "Sources", "Shared");
  await mkdir(shared, { recursive: true });
  const swiftValues = [
    'ImageAsset(name: "help"',
    "Help is available",
    "Something you wrote suggested you might not be safe right now.",
    "Caring, trained counselors are ready to listen, for free, 24/7.",
    "This message was shared for safety reasons",
    "Text 988",
    "Emergency resources",
    "Close",
  ];
  const stringsValues = [
    "They can help, whether or not things feel urgent.",
    "Messages that raise a safety concern are automatically shared with your provider at SonderMind.",
    "In the meantime, caring, trained counselors are ready to listen and support you right now, for free, 24/7.",
  ];
  await writeFile(
    join(shared, "SafetyAlert.swift"),
    swiftValues.filter((value) => value !== missing).join("\n"),
    "utf8",
  );
  await mkdir(join(shared, "Resources", "en.lproj"), { recursive: true });
  await writeFile(
    join(shared, "Resources", "en.lproj", "Localizable.strings"),
    stringsValues.filter((value) => value !== missing).join("\n"),
    "utf8",
  );
  return { root, cwd: join(root, "SonderClient"), sourceRoot: shared };
}

async function run(cwd: string, preloader?: string) {
  return exec(
    process.execPath,
    [
      ...(preloader === undefined ? [] : ["--require", preloader]),
      "--input-type=module",
      "-e",
      FULL_FLOW_SOURCE_PRECHECK_SCRIPT,
    ],
    { cwd, maxBuffer: 64 * 1024 },
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("full-flow source FAST precheck", () => {
  it("passes production source/resources without requiring model test files", async () => {
    const fixtureRoot = await fixture();
    await expect(run(fixtureRoot.cwd)).resolves.toMatchObject({ stdout: "" });
  });

  it.each(requiredSource)("rejects missing required source content: %s", async (missing) => {
    const fixtureRoot = await fixture(missing);
    await expect(run(fixtureRoot.cwd)).rejects.toMatchObject({ code: 1 });
  });

  it("fails closed when the source directory is missing", async () => {
    const fixtureRoot = await fixture();
    await rm(fixtureRoot.sourceRoot, { recursive: true });
    await expect(run(fixtureRoot.cwd)).rejects.toMatchObject({ code: 1 });
  });

  it("fails closed with the source read error, without permission assumptions", async () => {
    const fixtureRoot = await fixture();
    const preloader = join(fixtureRoot.root, "inject-read-error.cjs");
    await writeFile(
      preloader,
      [
        'const fs = require("node:fs/promises");',
        "const originalReadFile = fs.readFile;",
        "fs.readFile = async (path, ...args) => {",
        '  if (String(path).endsWith("SafetyAlert.swift")) {',
        '    const error = new Error("injected source read failure");',
        '    error.code = "EIO";',
        "    throw error;",
        "  }",
        "  return originalReadFile(path, ...args);",
        "};",
      ].join("\n"),
      "utf8",
    );
    await expect(run(fixtureRoot.cwd, preloader)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("EIO"),
    });
  });
});
