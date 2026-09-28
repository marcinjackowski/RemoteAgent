import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  TrustedEvaluatorInputError,
  trustedEvaluatorInputsDigest,
  validateTrustedEvaluatorInputs,
} from "../src/index.js";

const content = "import XCTest\n";
const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
const input = {
  files: [{ relative_path: "Tests/Generated/Probe.swift", content, content_digest: digest }],
  required_executed_test_ids: ["SharedTests/ProbeTests/testProbe()"],
};
const inputFile = input.files[0]!;
function file(relative_path: string, value = content) {
  return {
    relative_path,
    content: value,
    content_digest: `sha256:${createHash("sha256").update(value).digest("hex")}`,
  };
}

function uiHarnessInput(overrides: Record<string, unknown> = {}) {
  const root = "Tests/RemoteAgentUIHarness";
  const files = [
    file(`${root}/App/RemoteAgentUIHarnessApp.swift`, "import SwiftUI\n"),
    file(`${root}/UITests/RemoteAgentUIHarnessUITests.swift`, "import XCTest\n"),
    file(`${root}/RemoteAgentUIHarness.xcodeproj/project.pbxproj`, "// project\n"),
    file(
      `${root}/RemoteAgentUIHarness.xcodeproj/xcshareddata/xcschemes/RemoteAgentUIHarness.xcscheme`,
      "<Scheme/>\n",
    ),
  ];
  return {
    files,
    required_executed_test_ids: [
      "RemoteAgentUIHarnessUITests/RemoteAgentUIHarnessUITests/testGeneralHelp",
      "RemoteAgentUIHarnessUITests/RemoteAgentUIHarnessUITests/testActivitySharing",
    ],
    layout: "XCODE_UI_HARNESS_V1",
    ...overrides,
  };
}

describe("trusted evaluator inputs", () => {
  it("returns a frozen sorted snapshot with exact content digest", () => {
    const snapshot = validateTrustedEvaluatorInputs(input);
    expect(snapshot.files[0]).toEqual(inputFile);
    expect(snapshot.required_executed_test_ids).toEqual(["SharedTests/ProbeTests/testProbe"]);
    expect(snapshot.digest).toBe(trustedEvaluatorInputsDigest(input));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.files)).toBe(true);
  });

  it.each([
    ["wrong digest", { ...inputFile, content_digest: "sha256:" + "0".repeat(64) }],
    ["wildcard id", inputFile],
  ])("rejects %s", (label, file) => {
    const candidate =
      label === "wildcard id"
        ? { ...input, required_executed_test_ids: ["SharedTests/ProbeTests/*"] }
        : { ...input, files: [file] };
    expect(() => validateTrustedEvaluatorInputs(candidate)).toThrow(TrustedEvaluatorInputError);
  });

  it("rejects non-Swift, non-Tests, duplicate and oversized inputs", () => {
    for (const file of [
      { ...inputFile, relative_path: "Sources/Probe.swift" },
      { ...inputFile, relative_path: "Tests/Probe.txt" },
      {
        ...inputFile,
        relative_path: "Tests/Probe.swift",
        content: "x",
        content_digest: digest,
      },
    ]) {
      expect(() => validateTrustedEvaluatorInputs({ ...input, files: [file] })).toThrow();
    }
    expect(() =>
      validateTrustedEvaluatorInputs({ ...input, files: [inputFile, inputFile] }),
    ).toThrow();
    const large = "x".repeat(64 * 1024 + 1);
    const largeDigest = `sha256:${createHash("sha256").update(large).digest("hex")}`;
    expect(() =>
      validateTrustedEvaluatorInputs({
        ...input,
        files: [
          { relative_path: "Tests/Large.swift", content: large, content_digest: largeDigest },
        ],
      }),
    ).toThrow();
  });

  it("accepts exact file and aggregate limits with multibyte UTF-8", () => {
    const one = "ą".repeat(32 * 1024);
    const files = Array.from({ length: 4 }, (_, index) => file(`Tests/Limit${index}.swift`, one));
    expect(
      validateTrustedEvaluatorInputs({ files, required_executed_test_ids: ["T/S/test"] })
        .total_bytes,
    ).toBe(Buffer.byteLength(one) * 4);
    expect(
      validateTrustedEvaluatorInputs({
        files: Array.from({ length: 16 }, (_, i) => file(`Tests/Count${i}.swift`)),
        required_executed_test_ids: Array.from({ length: 128 }, (_, i) => `T/S/test${i}`),
      }).files,
    ).toHaveLength(16);
    expect(() =>
      validateTrustedEvaluatorInputs({
        files: Array.from({ length: 17 }, (_, i) => file(`Tests/${i}.swift`)),
        required_executed_test_ids: ["T/S/test"],
      }),
    ).toThrow();
  });

  it("rejects over-limit, invalid UTF-8, IDs, paths, and unknown fields", () => {
    const tooLarge = "x".repeat(64 * 1024 + 1);
    expect(() =>
      validateTrustedEvaluatorInputs({
        files: [file("Tests/Large.swift", tooLarge)],
        required_executed_test_ids: ["T/S/test"],
      }),
    ).toThrow();
    const aggregate = [
      ...Array.from({ length: 4 }, (_, i) => file(`Tests/A${i}.swift`, "x".repeat(64 * 1024))),
      file("Tests/A4.swift", "x"),
    ];
    expect(() =>
      validateTrustedEvaluatorInputs({
        files: aggregate,
        required_executed_test_ids: ["T/S/test"],
      }),
    ).toThrow();
    expect(() =>
      validateTrustedEvaluatorInputs({
        files: [file("Tests/Bad.swift", "\ud800")],
        required_executed_test_ids: ["T/S/test"],
      }),
    ).toThrow();
    for (const candidate of [
      { files: [], required_executed_test_ids: ["T/S/test"] },
      { files: [inputFile], required_executed_test_ids: [] },
      {
        files: [inputFile],
        required_executed_test_ids: Array.from({ length: 129 }, (_, i) => `T/S/test${i}`),
      },
      { files: [inputFile], required_executed_test_ids: ["T/S/test()", "T/S/test"] },
      { files: [inputFile], required_executed_test_ids: ["T/S/*"] },
      { files: [inputFile], required_executed_test_ids: ["T/Bad Suite/test"] },
      { files: [inputFile], required_executed_test_ids: ["T/S/"] },
      {
        files: [{ ...inputFile, relative_path: "../Tests/Bad.swift" }],
        required_executed_test_ids: ["T/S/test"],
      },
      {
        files: [{ ...inputFile, relative_path: "/Tests/Bad.swift" }],
        required_executed_test_ids: ["T/S/test"],
      },
      {
        files: [{ ...inputFile, relative_path: "Tests/.GIT/Bad.swift" }],
        required_executed_test_ids: ["T/S/test"],
      },
      { files: [{ ...inputFile, extra: true }], required_executed_test_ids: ["T/S/test"] },
      { files: [null], required_executed_test_ids: ["T/S/test"] },
      { files: [inputFile], required_executed_test_ids: [null] },
    ])
      expect(() => validateTrustedEvaluatorInputs(candidate as never)).toThrow();
    expect(() => validateTrustedEvaluatorInputs({ ...input, unexpected: true } as never)).toThrow();
    expect(() => validateTrustedEvaluatorInputs(null as never)).toThrow();
  });

  it("rejects parent conflicts and freezes nested values with reorder-stable identity", () => {
    expect(() =>
      validateTrustedEvaluatorInputs({
        files: [
          file("Tests/A.swift"),
          file("Tests/A.swift-Z.swift"),
          file("Tests/A.swift/B.swift"),
        ],
        required_executed_test_ids: ["T/S/test"],
      }),
    ).toThrow();
    const a = validateTrustedEvaluatorInputs({
      files: [file("Tests/B.swift"), file("Tests/A.swift")],
      required_executed_test_ids: ["T/S/test", "T/U/test"],
    });
    const b = validateTrustedEvaluatorInputs({
      files: [file("Tests/A.swift"), file("Tests/B.swift")],
      required_executed_test_ids: ["T/U/test", "T/S/test"],
    });
    expect(a.digest).toBe(b.digest);
    expect(Object.isFrozen(a.files[0])).toBe(true);
    expect(Object.isFrozen(a.required_executed_test_ids)).toBe(true);
    const baseline = {
      files: [file("Tests/A.swift"), file("Tests/B.swift")],
      required_executed_test_ids: ["T/S/test", "T/U/test"],
    };
    expect(
      validateTrustedEvaluatorInputs({
        ...baseline,
        required_executed_test_ids: ["T/S/other", "T/U/test"],
      }).digest,
    ).not.toBe(a.digest);
    expect(
      validateTrustedEvaluatorInputs({
        ...baseline,
        files: [file("Tests/A.swift", "changed"), file("Tests/B.swift")],
      }).digest,
    ).not.toBe(a.digest);
  });

  it("rejects sparse file and test-id arrays", () => {
    const files = new Array(1) as unknown as typeof input.files;
    const ids = new Array(1) as unknown as typeof input.required_executed_test_ids;
    expect(() =>
      validateTrustedEvaluatorInputs({ files, required_executed_test_ids: ["T/S/test"] }),
    ).toThrow();
    expect(() =>
      validateTrustedEvaluatorInputs({ files: [inputFile], required_executed_test_ids: ids }),
    ).toThrow();
  });

  it("accepts the isolated UI harness layout with exact discriminator identity", () => {
    const candidate = uiHarnessInput();
    const snapshot = validateTrustedEvaluatorInputs(candidate);
    expect(snapshot.layout).toBe("XCODE_UI_HARNESS_V1");
    expect(snapshot.files).toHaveLength(4);
    expect(Object.hasOwn(snapshot, "layout")).toBe(true);
    const sortedFiles = [...candidate.files].sort((a, b) =>
      a.relative_path.localeCompare(b.relative_path),
    );
    const expectedSnapshot = {
      files: sortedFiles,
      required_executed_test_ids: [...candidate.required_executed_test_ids].sort(),
      total_bytes: sortedFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
      layout: "XCODE_UI_HARNESS_V1",
    };
    expect(snapshot.digest).toBe(
      `sha256:${createHash("sha256").update(JSON.stringify(expectedSnapshot)).digest("hex")}`,
    );
  });

  it("accepts only the optional reference Package.resolved and binds its bytes to identity", () => {
    const lockPath =
      "Tests/RemoteAgentUIHarness/RemoteAgentUIHarness.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved";
    const value = uiHarnessInput();
    value.files.push(file(lockPath, '{"pins":[]}' + "\n"));
    const snapshot = validateTrustedEvaluatorInputs(value);
    expect(snapshot.files).toHaveLength(5);
    expect(snapshot.files.find(({ relative_path }) => relative_path === lockPath)?.content).toBe(
      '{"pins":[]}\n',
    );
    const changed = uiHarnessInput();
    changed.files.push(file(lockPath, '{"pins":["changed"]}' + "\n"));
    expect(validateTrustedEvaluatorInputs(changed).digest).not.toBe(snapshot.digest);
    for (const rejectedPath of [
      lockPath.replace("Package.resolved", "Package.json"),
      "Tests/RemoteAgentUIHarness/Package.resolved",
      "Other/RemoteAgentUIHarness.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
    ]) {
      const rejected = uiHarnessInput();
      rejected.files.push(file(rejectedPath, '{"pins":[]}' + "\n"));
      expect(() => validateTrustedEvaluatorInputs(rejected)).toThrow(TrustedEvaluatorInputError);
    }
  });

  type UiHarnessMutation = (value: ReturnType<typeof uiHarnessInput>) => void;
  const invalidUiHarnessCases: readonly (readonly [string, UiHarnessMutation])[] = [
    ...[0, 1, 2, 3].map(
      (index) =>
        [
          `missing required file ${index}`,
          (value: ReturnType<typeof uiHarnessInput>) => value.files.splice(index, 1),
        ] as const,
    ),
    [
      "non-Swift extra",
      (value: ReturnType<typeof uiHarnessInput>) =>
        value.files.push(file("Tests/RemoteAgentUIHarness/App/Info.plist")),
    ],
    [
      "NotTests root",
      (value: ReturnType<typeof uiHarnessInput>) => {
        value.files.forEach((file) => {
          file.relative_path = file.relative_path.replace(
            "Tests/RemoteAgentUIHarness",
            "NotTests/RemoteAgentUIHarness",
          );
        });
      },
    ],
    [
      "wrong test target",
      (value: ReturnType<typeof uiHarnessInput>) => {
        value.required_executed_test_ids[0] = "SharedTests/Probe/test";
      },
    ],
  ];
  it.each(invalidUiHarnessCases)("rejects UI harness %s", (_label, mutate) => {
    const value = uiHarnessInput();
    mutate(value);
    expect(() => validateTrustedEvaluatorInputs(value)).toThrow(TrustedEvaluatorInputError);
  });

  it("accepts a prefixed sibling Tests root and extra Swift only in App/UITests", () => {
    const value = uiHarnessInput();
    value.files.forEach((file) => {
      file.relative_path = file.relative_path.replace(
        "Tests/RemoteAgentUIHarness",
        "Foo/Tests/RemoteAgentUIHarness",
      );
    });
    value.files.push(file("Foo/Tests/RemoteAgentUIHarness/App/Extra.swift"));
    expect(validateTrustedEvaluatorInputs(value).layout).toBe("XCODE_UI_HARNESS_V1");
    value.files.push(file("Foo/Tests/RemoteAgentUIHarness/Other.swift"));
    expect(() => validateTrustedEvaluatorInputs(value)).toThrow(TrustedEvaluatorInputError);
  });
});
