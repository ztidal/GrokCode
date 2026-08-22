import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as releaseContract from "./release-contract.mjs";

const script = new URL("./release.mjs", import.meta.url);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("cross-platform release handoff", () => {
  it("strips signing secrets from every non-build child environment", () => {
    expect(
      releaseContract.sanitizedReleaseEnvironment({
        PATH: "test-path",
        TAURI_SIGNING_PRIVATE_KEY: "secret-key",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "secret-password",
      }),
    ).toEqual({ PATH: "test-path" });
  });

  it("uses the sanitized environment for installed-version verification", () => {
    const source = readFileSync(script, "utf8");
    const start = source.indexOf('const ps = spawnSync(\n    "powershell"');
    const end = source.indexOf("if (ps.status", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain("env: cleanEnv");
  });

  it("lets the Windows builder stage a draft but not publish it", () => {
    const result = spawnSync(process.execPath, [script.pathname, "--help"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--draft");
    expect(result.stdout).not.toContain("--publish");
    expect(result.stdout).toContain("only the two Windows installers and signatures");
    expect(result.stdout).toContain("Mac-side release owner");
    expect(result.stdout).toContain("src-tauri/target/release/windows-handoff.json");
    expect(result.stdout).toContain("never uploaded");
  });

  it("requires the Windows draft to reuse the committed release SHA", () => {
    const result = spawnSync(
      process.execPath,
      [script.pathname, "--draft", "--notes", "release notes"],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--draft requires --no-commit");
  });

  it("refuses to mutate any existing release tag, even a Windows-only draft", () => {
    const assertAbsent = releaseContract.assertWindowsReleaseTagAbsent;

    expect(() =>
      assertAbsent(
        {
          found: true,
          isDraft: true,
          assetNames: [
            "ZtidalCode_0.0.36_x64-setup.exe",
            "ZtidalCode_0.0.36_x64-setup.exe.sig",
            "ZtidalCode_0.0.36_x64_en-US.msi",
            "ZtidalCode_0.0.36_x64_en-US.msi.sig",
          ],
        },
        { repo: "ztidal/ZtidalCode-dist", tag: "v0.0.36" },
      ),
    ).toThrow("Windows staging is immutable");
    expect(() =>
      assertAbsent(
        { found: true, isDraft: false, assetNames: [] },
        { repo: "ztidal/ZtidalCode-dist", tag: "v0.0.36" },
      ),
    ).toThrow("already published");
    expect(
      assertAbsent(
        { found: false },
        { repo: "ztidal/ZtidalCode-dist", tag: "v0.0.36" },
      ),
    ).toBeUndefined();
  });

  it("lists all matching drafts and fails closed when the release lookup fails", () => {
    const readReleaseTag = releaseContract.readReleaseTag;
    const state = readReleaseTag({
      repo: "ztidal/ZtidalCode-dist",
      tag: "v0.0.36",
      run(command, args, options) {
        const expected = [
          "release",
          "list",
          "--repo",
          "ztidal/ZtidalCode-dist",
          "--limit",
          "1000",
          "--json",
          "tagName,isDraft",
        ];
        if (
          command !== "gh" ||
          options.encoding !== "utf8" ||
          JSON.stringify(args) !== JSON.stringify(expected)
        ) {
          return { status: 1, stdout: "", stderr: "wrong gh query" };
        }
        return {
          status: 0,
          stdout: JSON.stringify([
            { tagName: "v0.0.35", isDraft: false },
            { tagName: "v0.0.36", isDraft: true },
            { tagName: "v0.0.36", isDraft: true },
          ]),
          stderr: "",
        };
      },
    });

    expect(state).toEqual({
      found: true,
      isDraft: true,
      count: 2,
    });
    expect(
      readReleaseTag({
        repo: "ztidal/ZtidalCode-dist",
        tag: "v0.0.36",
        run: () => ({ status: 0, stdout: "[]", stderr: "" }),
      }),
    ).toEqual({ found: false });
    expect(() =>
      readReleaseTag({
        repo: "ztidal/ZtidalCode-dist",
        tag: "v0.0.36",
        run: () => ({ status: 1, stdout: "", stderr: "network failed" }),
      }),
    ).toThrow("release lookup failed");
  });

  it("checks the exact dist git tag and fails closed on lookup errors", () => {
    const readRemoteGitTag = releaseContract.readRemoteGitTag;
    const expectedArgs = [
      "ls-remote",
      "--exit-code",
      "https://github.com/ztidal/ZtidalCode-dist.git",
      "refs/tags/v0.0.36",
    ];

    expect(
      readRemoteGitTag({
        repo: "ztidal/ZtidalCode-dist",
        tag: "v0.0.36",
        run(command, args) {
          expect(command).toBe("git");
          expect(args).toEqual(expectedArgs);
          return {
            status: 0,
            stdout: `${"a".repeat(40)}\trefs/tags/v0.0.36\n`,
            stderr: "",
          };
        },
      }),
    ).toEqual({ found: true, sha: "a".repeat(40) });
    expect(
      readRemoteGitTag({
        repo: "ztidal/ZtidalCode-dist",
        tag: "v0.0.36",
        run: () => ({ status: 2, stdout: "", stderr: "" }),
      }),
    ).toEqual({ found: false });
    expect(() =>
      readRemoteGitTag({
        repo: "ztidal/ZtidalCode-dist",
        tag: "v0.0.36",
        run: () => ({ status: 128, stdout: "", stderr: "network failed" }),
      }),
    ).toThrow("remote tag lookup failed");
  });

  it("describes the raw Windows binary and exactly four draft assets by digest", () => {
    const root = mkdtempSync(join(tmpdir(), "ztidal-release-handoff-"));
    temporaryDirectories.push(root);
    const files = [
      ["PinkCode.exe", "windows binary"],
      ["ZtidalCode_0.0.36_x64-setup.exe", "nsis installer"],
      ["ZtidalCode_0.0.36_x64-setup.exe.sig", "nsis signature"],
      ["ZtidalCode_0.0.36_x64_en-US.msi", "msi installer"],
      ["ZtidalCode_0.0.36_x64_en-US.msi.sig", "msi signature"],
    ] as const;
    for (const [name, contents] of files) {
      writeFileSync(join(root, name), contents);
    }

    const buildWindowsHandoff = (
      releaseContract as typeof releaseContract & {
        buildWindowsHandoff?: (options: {
          productName: string;
          version: string;
          sourceSha: string;
          windowsBinaryPath: string;
          assetPaths: string[];
        }) => unknown;
      }
    ).buildWindowsHandoff;
    expect(buildWindowsHandoff).toBeTypeOf("function");

    const handoff = buildWindowsHandoff!({
      productName: "ZtidalCode",
      version: "0.0.36",
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
      windowsBinaryPath: join(root, files[0][0]),
      assetPaths: files.slice(1).map(([name]) => join(root, name)),
    });

    expect(handoff).toEqual({
      version: "0.0.36",
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
      files: [
        {
          name: "PinkCode.exe",
          sha256: "6cfe3112ad2ec3522962089ae28742a8e71491b77a460fe1b083477a5892be46",
        },
        {
          name: "ZtidalCode_0.0.36_x64-setup.exe",
          sha256: "ad1435b4ddd2fad9931e962a4bfab6ee03c4372646b48ffe872692c33cff1084",
        },
        {
          name: "ZtidalCode_0.0.36_x64-setup.exe.sig",
          sha256: "b0ba6cc481ac5ddf57f6350d588c7a7304d19d27f3bc5c94729268df60f100c8",
        },
        {
          name: "ZtidalCode_0.0.36_x64_en-US.msi",
          sha256: "8859c0815acc2a2115c3c4eabc3064a399f60586b10e0a2594841d94a1baa4d6",
        },
        {
          name: "ZtidalCode_0.0.36_x64_en-US.msi.sig",
          sha256: "bb0189c9ce703fddf6dfbc71b0530ceee06043f7ad5e84b7faf57493357c0173",
        },
      ],
    });
  });

  it("rejects a handoff that does not name one full source commit", () => {
    const buildWindowsHandoff = (
      releaseContract as typeof releaseContract & {
        buildWindowsHandoff: (options: {
          productName: string;
          version: string;
          sourceSha: string;
          windowsBinaryPath: string;
          assetPaths: string[];
        }) => unknown;
      }
    ).buildWindowsHandoff;

    expect(() =>
      buildWindowsHandoff({
        productName: "ZtidalCode",
        version: "0.0.36",
        sourceSha: "db9621b",
        windowsBinaryPath: "missing/PinkCode.exe",
        assetPaths: [],
      }),
    ).toThrow("sourceSha must be a full 40-character Git commit SHA");
  });

  it("rejects Windows assets from a different version or filename", () => {
    const buildWindowsHandoff = (
      releaseContract as typeof releaseContract & {
        buildWindowsHandoff: (options: {
          productName: string;
          version: string;
          sourceSha: string;
          windowsBinaryPath: string;
          assetPaths: string[];
        }) => unknown;
      }
    ).buildWindowsHandoff;

    expect(() =>
      buildWindowsHandoff({
        productName: "ZtidalCode",
        version: "0.0.36",
        sourceSha: "0123456789abcdef0123456789abcdef01234567",
        windowsBinaryPath: "missing/PinkCode.exe",
        assetPaths: [
          "missing/ZtidalCode_0.0.35_x64-setup.exe",
          "missing/ZtidalCode_0.0.35_x64-setup.exe.sig",
          "missing/ZtidalCode_0.0.35_x64_en-US.msi",
          "missing/ZtidalCode_0.0.35_x64_en-US.msi.sig",
        ],
      }),
    ).toThrow("Windows handoff assets do not exactly match version 0.0.36");
  });

  it("requires provenance for the raw PinkCode.exe binary", () => {
    const buildWindowsHandoff = (
      releaseContract as typeof releaseContract & {
        buildWindowsHandoff: (options: {
          productName: string;
          version: string;
          sourceSha: string;
          windowsBinaryPath: string;
          assetPaths: string[];
        }) => unknown;
      }
    ).buildWindowsHandoff;

    expect(() =>
      buildWindowsHandoff({
        productName: "ZtidalCode",
        version: "0.0.36",
        sourceSha: "0123456789abcdef0123456789abcdef01234567",
        windowsBinaryPath: "missing/Other.exe",
        assetPaths: [
          "missing/ZtidalCode_0.0.36_x64-setup.exe",
          "missing/ZtidalCode_0.0.36_x64-setup.exe.sig",
          "missing/ZtidalCode_0.0.36_x64_en-US.msi",
          "missing/ZtidalCode_0.0.36_x64_en-US.msi.sig",
        ],
      }),
    ).toThrow("Windows handoff binary must be PinkCode.exe");
  });
});
