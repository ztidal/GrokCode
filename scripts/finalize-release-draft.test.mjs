import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as finalizer from "./finalize-release-draft.mjs";

const expectedSha = "0123456789abcdef0123456789abcdef01234567";
const parseFinalizeArgs = finalizer.parseFinalizeArgs;

describe("finalize release draft CLI", () => {
  it("accepts the three release inputs and one optional signing-key path", () => {
    expect(
      parseFinalizeArgs([
        "--expected-sha",
        expectedSha,
        "--windows-handoff",
        "handoff.json",
        "--notes-file",
        "NOTES.md",
      ]),
    ).toEqual({
      expectedSha,
      windowsHandoff: "handoff.json",
      notesFile: "NOTES.md",
      keyFile: null,
      help: false,
    });
    expect(
      parseFinalizeArgs([
        "--expected-sha",
        expectedSha,
        "--windows-handoff",
        "handoff.json",
        "--notes-file",
        "NOTES.md",
        "--key",
        "/secure/ztidal.key",
      ]),
    ).toEqual({
      expectedSha,
      windowsHandoff: "handoff.json",
      notesFile: "NOTES.md",
      keyFile: "/secure/ztidal.key",
      help: false,
    });
  });

  it("rejects unknown, duplicate, positional, missing, and malformed inputs", () => {
    const valid = [
      "--expected-sha",
      expectedSha,
      "--windows-handoff",
      "handoff.json",
      "--notes-file",
      "NOTES.md",
    ];

    expect(() => parseFinalizeArgs([...valid, "--repo", "other/repo"])).toThrow(
      "unknown flag --repo",
    );
    expect(() => parseFinalizeArgs([...valid, "--notes-file", "again.md"])).toThrow(
      "duplicate flag --notes-file",
    );
    expect(() =>
      parseFinalizeArgs([
        ...valid,
        "--key",
        "first.key",
        "--key",
        "second.key",
      ]),
    ).toThrow("duplicate flag --key");
    expect(() => parseFinalizeArgs(["handoff.json", ...valid])).toThrow(
      "unexpected argument handoff.json",
    );
    expect(() => parseFinalizeArgs(valid.slice(0, -2))).toThrow(
      "--notes-file is required",
    );
    expect(() =>
      parseFinalizeArgs([
        "--expected-sha",
        "abc123",
        "--windows-handoff",
        "handoff.json",
        "--notes-file",
        "NOTES.md",
      ]),
    ).toThrow("--expected-sha must be exactly 40 hexadecimal characters");
    expect(() => parseFinalizeArgs(["--expected-sha", "--windows-handoff"])).toThrow(
      "--expected-sha needs a value",
    );
  });

  it("allows --help only and refuses to mix it with release inputs", () => {
    expect(parseFinalizeArgs(["--help"])).toEqual({ help: true });
    expect(() => parseFinalizeArgs(["--help", "--notes-file", "NOTES.md"])).toThrow(
      "--help cannot be combined with other arguments",
    );
  });
});

describe("release layout and Windows handoff", () => {
  const version = "0.0.36";
  const layoutOptions = {
    repoRoot: "/repo",
    productName: "ZtidalCode",
    version,
  };
  const names = [
    "PinkCode.exe",
    "ZtidalCode_0.0.36_x64-setup.exe",
    "ZtidalCode_0.0.36_x64-setup.exe.sig",
    "ZtidalCode_0.0.36_x64_en-US.msi",
    "ZtidalCode_0.0.36_x64_en-US.msi.sig",
  ];
  const files = names.map((name, index) => ({
    name,
    sha256: String(index + 1).repeat(64),
  }));

  it("derives every local path instead of accepting paths from the handoff", () => {
    const layout = finalizer.createReleaseLayout?.(layoutOptions);

    expect(layout).toMatchObject({
      tag: "v0.0.36",
      rawWindowsExe: {
        name: "PinkCode.exe",
        path: join("/repo", "src-tauri", "target", "release", "PinkCode.exe"),
      },
      windows: [
        {
          name: "ZtidalCode_0.0.36_x64-setup.exe",
          path: join(
            "/repo",
            "src-tauri",
            "target",
            "release",
            "bundle",
            "nsis",
            "ZtidalCode_0.0.36_x64-setup.exe",
          ),
        },
        {
          name: "ZtidalCode_0.0.36_x64-setup.exe.sig",
          path: join(
            "/repo",
            "src-tauri",
            "target",
            "release",
            "bundle",
            "nsis",
            "ZtidalCode_0.0.36_x64-setup.exe.sig",
          ),
        },
        {
          name: "ZtidalCode_0.0.36_x64_en-US.msi",
          path: join(
            "/repo",
            "src-tauri",
            "target",
            "release",
            "bundle",
            "msi",
            "ZtidalCode_0.0.36_x64_en-US.msi",
          ),
        },
        {
          name: "ZtidalCode_0.0.36_x64_en-US.msi.sig",
          path: join(
            "/repo",
            "src-tauri",
            "target",
            "release",
            "bundle",
            "msi",
            "ZtidalCode_0.0.36_x64_en-US.msi.sig",
          ),
        },
      ],
      mac: [
        { name: "ZtidalCode_0.0.36_aarch64.dmg" },
        { name: "ZtidalCode.app.tar.gz" },
        { name: "ZtidalCode.app.tar.gz.sig" },
      ],
      metadata: [
        { name: "latest.json", path: join("/repo", "latest.json") },
        { name: "SHA256SUMS.txt", path: join("/repo", "SHA256SUMS.txt") },
      ],
    });
    expect(layout?.handoffNames).toEqual(names);
  });

  it("can derive an isolated native-target release and metadata layout", () => {
    const layout = finalizer.createReleaseLayout?.({
      ...layoutOptions,
      releaseRoot: join(
        "/fresh-cargo-target",
        "aarch64-apple-darwin",
        "release",
      ),
      metadataRoot: "/fresh-cargo-target",
    });

    expect(layout?.releaseRoot).toBe(
      join("/fresh-cargo-target", "aarch64-apple-darwin", "release"),
    );
    expect(layout?.rawWindowsExe.path).toBe(
      join(
        "/fresh-cargo-target",
        "aarch64-apple-darwin",
        "release",
        "PinkCode.exe",
      ),
    );
    expect(layout?.mac.map(({ path }) => path)).toEqual([
      join(
        "/fresh-cargo-target",
        "aarch64-apple-darwin",
        "release",
        "bundle",
        "dmg",
        "ZtidalCode_0.0.36_aarch64.dmg",
      ),
      join(
        "/fresh-cargo-target",
        "aarch64-apple-darwin",
        "release",
        "bundle",
        "macos",
        "ZtidalCode.app.tar.gz",
      ),
      join(
        "/fresh-cargo-target",
        "aarch64-apple-darwin",
        "release",
        "bundle",
        "macos",
        "ZtidalCode.app.tar.gz.sig",
      ),
    ]);
    expect(layout?.metadata.map(({ path }) => path)).toEqual([
      join("/fresh-cargo-target", "latest.json"),
      join("/fresh-cargo-target", "SHA256SUMS.txt"),
    ]);
  });

  it("accepts exactly five unique expected names with strict hashes", () => {
    const result = finalizer.validateWindowsHandoff?.(
      { version, sourceSha: expectedSha.toUpperCase(), files: [...files].reverse() },
      { version, expectedSha, expectedNames: names },
    );

    expect(result).toEqual({
      version,
      sourceSha: expectedSha,
      files,
    });
  });

  it("rejects extra keys, paths, duplicates, missing names, and mismatched identity", () => {
    const validate = (handoff) =>
      finalizer.validateWindowsHandoff?.(handoff, {
        version,
        expectedSha,
        expectedNames: names,
      });

    expect(() => validate({ version, sourceSha: expectedSha, files, extra: true })).toThrow(
      "handoff has unexpected keys: extra",
    );
    expect(() =>
      validate({
        version,
        sourceSha: expectedSha,
        files: [{ ...files[0], path: "/tmp/PinkCode.exe" }, ...files.slice(1)],
      }),
    ).toThrow("handoff file PinkCode.exe has unexpected keys: path");
    expect(() => validate({ version: "0.0.35", sourceSha: expectedSha, files })).toThrow(
      "handoff version 0.0.35 does not match branding version 0.0.36",
    );
    expect(() =>
      validate({ version, sourceSha: "f".repeat(40), files }),
    ).toThrow("handoff sourceSha does not match --expected-sha");
    expect(() =>
      validate({ version, sourceSha: expectedSha, files: files.slice(0, 4) }),
    ).toThrow("handoff must list exactly 5 files");
    expect(() =>
      validate({
        version,
        sourceSha: expectedSha,
        files: [files[0], files[0], ...files.slice(2)],
      }),
    ).toThrow("handoff contains duplicate file PinkCode.exe");
    expect(() =>
      validate({
        version,
        sourceSha: expectedSha,
        files: [{ name: "other.exe", sha256: "a".repeat(64) }, ...files.slice(1)],
      }),
    ).toThrow("handoff file names do not match the expected Windows handoff");
    expect(() =>
      validate({
        version,
        sourceSha: expectedSha,
        files: [{ name: names[0], sha256: "not-a-hash" }, ...files.slice(1)],
      }),
    ).toThrow("handoff SHA256 for PinkCode.exe must be 64 hexadecimal characters");
  });
});

describe("GitHub draft state", () => {
  const windowsAssets = [
    "ZtidalCode_0.0.36_x64-setup.exe",
    "ZtidalCode_0.0.36_x64-setup.exe.sig",
    "ZtidalCode_0.0.36_x64_en-US.msi",
    "ZtidalCode_0.0.36_x64_en-US.msi.sig",
  ].map((name, index) => ({ name, sha256: String(index + 1).repeat(64) }));
  const release = (assets = windowsAssets, isDraft = true) => ({
    isDraft,
    name: "ZtidalCode 0.0.36",
    body: "Mac and Windows release",
    assets: assets.map(({ name, sha256 }) => ({
      name,
      ...(sha256 === undefined ? {} : { digest: `sha256:${sha256}` }),
    })),
  });

  it("accepts only exact asset names and SHA-256 digests", () => {
    expect(
      finalizer.validateDraftState?.(
        release([...windowsAssets].reverse()),
        windowsAssets,
        "before finalization",
      ),
    ).toEqual(windowsAssets.map(({ name }) => name).sort());
  });

  it("rejects published, duplicate, missing, or extra draft assets", () => {
    const validate = (value) =>
      finalizer.validateDraftState?.(value, windowsAssets, "before finalization");

    expect(() => validate(release(windowsAssets, false))).toThrow(
      "before finalization: release is not a draft",
    );
    expect(() => validate(release(windowsAssets.slice(1)))).toThrow(
      "before finalization: asset set does not match",
    );
    expect(() =>
      validate(
        release([
          ...windowsAssets,
          { name: "latest.json", sha256: "f".repeat(64) },
        ]),
      ),
    ).toThrow(
      "before finalization: asset set does not match",
    );
    expect(() =>
      validate(release([...windowsAssets.slice(0, 3), windowsAssets[0]])),
    ).toThrow("before finalization: duplicate asset ZtidalCode_0.0.36_x64-setup.exe");
  });

  it("fails closed on a missing, malformed, or mismatched remote digest", () => {
    const validate = (value) =>
      finalizer.validateDraftState?.(value, windowsAssets, "before finalization");
    const missing = release([
      { ...windowsAssets[0], sha256: undefined },
      ...windowsAssets.slice(1),
    ]);
    const malformed = release();
    malformed.assets[0].digest = `sha512:${"1".repeat(64)}`;
    const mismatched = release();
    mismatched.assets[0].digest = `sha256:${"f".repeat(64)}`;

    expect(() => validate(missing)).toThrow(
      "before finalization: asset ZtidalCode_0.0.36_x64-setup.exe digest must be sha256:<64 lowercase hex>",
    );
    expect(() => validate(malformed)).toThrow(
      "before finalization: asset ZtidalCode_0.0.36_x64-setup.exe digest must be sha256:<64 lowercase hex>",
    );
    expect(() => validate(mismatched)).toThrow(
      "before finalization: SHA256 mismatch for remote asset ZtidalCode_0.0.36_x64-setup.exe",
    );
  });

  it("strictly checks the finalized release title and body", () => {
    const expectedRelease = {
      name: "ZtidalCode 0.0.36",
      body: "Mac and Windows release",
    };
    expect(
      finalizer.validateDraftState?.(
        release(),
        windowsAssets,
        "after finalization",
        expectedRelease,
      ),
    ).toEqual(windowsAssets.map(({ name }) => name).sort());
    expect(() =>
      finalizer.validateDraftState?.(
        { ...release(), name: "Wrong title" },
        windowsAssets,
        "after finalization",
        expectedRelease,
      ),
    ).toThrow("after finalization: release name does not match ZtidalCode 0.0.36");
    expect(() =>
      finalizer.validateDraftState?.(
        { ...release(), body: "stale notes" },
        windowsAssets,
        "after finalization",
        expectedRelease,
      ),
    ).toThrow("after finalization: release body does not match release notes");
  });
});

describe("branding and local artifacts", () => {
  const layout = finalizer.createReleaseLayout({
    repoRoot: "/repo",
    productName: "ZtidalCode",
    version: "0.0.36",
  });
  const localEntries = [
    layout.rawWindowsExe,
    ...layout.windows,
    ...layout.mac,
  ];
  const bytes = new Map(
    localEntries.map(({ name, path }) => [path, Buffer.from(`local:${name}`)]),
  );
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const handoff = {
    version: "0.0.36",
    sourceSha: expectedSha,
    files: [layout.rawWindowsExe, ...layout.windows].map(({ name, path }) => ({
      name,
      sha256: digest(bytes.get(path)),
    })),
  };

  it("derives the exact dist repository from the branding updater endpoint", () => {
    expect(
      finalizer.validateBrandingConfig?.({
        version: "0.0.36",
        productName: "ZtidalCode",
        plugins: {
          updater: {
            endpoints: [
              "https://github.com/ztidal/ZtidalCode-dist/releases/latest/download/latest.json",
            ],
          },
        },
      }),
    ).toEqual({
      version: "0.0.36",
      productName: "ZtidalCode",
      repo: "ztidal/ZtidalCode-dist",
      tag: "v0.0.36",
    });
  });

  it("rejects an unexpected product or an endpoint that is not the exact latest feed", () => {
    const base = {
      version: "0.0.36",
      productName: "ZtidalCode",
      plugins: {
        updater: {
          endpoints: [
            "https://github.com/ztidal/ZtidalCode-dist/releases/latest/download/latest.json",
          ],
        },
      },
    };
    expect(() =>
      finalizer.validateBrandingConfig?.({ ...base, productName: "Other" }),
    ).toThrow("branding productName must be ZtidalCode");
    expect(() =>
      finalizer.validateBrandingConfig?.({
        ...base,
        plugins: {
          updater: {
            endpoints: [
              "https://example.com/ztidal/ZtidalCode-dist/releases/latest/download/latest.json",
            ],
          },
        },
      }),
    ).toThrow("cannot derive an exact GitHub repository from the branding updater endpoint");
  });

  it("reads every derived artifact and verifies all five Windows handoff hashes", () => {
    const result = finalizer.verifyLocalArtifacts?.({
      layout,
      handoff,
      readFile: (path) => bytes.get(path),
    });

    expect(Object.keys(result?.sha256ByName ?? {}).sort()).toEqual(
      localEntries.map(({ name }) => name).sort(),
    );
    for (const { name, path } of localEntries) {
      expect(result?.sha256ByName[name]).toBe(digest(bytes.get(path)));
    }
  });

  it("fails before publication commands on a missing, empty, or mismatched artifact", () => {
    const verify = (readFile, value = handoff) =>
      finalizer.verifyLocalArtifacts?.({ layout, handoff: value, readFile });
    const missingPath = layout.mac[0].path;
    expect(() =>
      verify((path) => {
        if (path === missingPath) throw new Error("ENOENT");
        return bytes.get(path);
      }),
    ).toThrow(`cannot read local artifact ${layout.mac[0].name}: ENOENT`);
    expect(() => verify((path) => (path === missingPath ? Buffer.alloc(0) : bytes.get(path)))).toThrow(
      `local artifact ${layout.mac[0].name} is empty`,
    );
    expect(() =>
      verify((path) => bytes.get(path), {
        ...handoff,
        files: handoff.files.map((file, index) =>
          index === 1 ? { ...file, sha256: "f".repeat(64) } : file,
        ),
      }),
    ).toThrow(`SHA256 mismatch for ${layout.windows[0].name}`);
  });
});

describe("Mac signing-key isolation", () => {
  it("uses a truthy environment key before --key and ZTIDAL_SIGNING_KEY_FILE", () => {
    const resolveSigningKey = finalizer.resolveSigningKey;
    expect(resolveSigningKey).toBeTypeOf("function");
    if (typeof resolveSigningKey !== "function") return;

    const reads = [];
    const resolved = resolveSigningKey({
      environment: {
        TAURI_SIGNING_PRIVATE_KEY: "environment-secret",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "environment-password",
        ZTIDAL_SIGNING_KEY_FILE: "/secure/fallback.key",
      },
      keyFile: "/secure/cli.key",
      readFile(path) {
        reads.push(path);
        return "file-secret";
      },
    });

    expect(resolved).toEqual({
      privateKey: "environment-secret",
      password: "environment-password",
    });
    expect(reads).toEqual([]);
  });

  it("falls back from an empty environment key to --key, then ZTIDAL_SIGNING_KEY_FILE", () => {
    const resolveSigningKey = finalizer.resolveSigningKey;
    expect(resolveSigningKey).toBeTypeOf("function");
    if (typeof resolveSigningKey !== "function") return;

    expect(
      resolveSigningKey({
        environment: {
          TAURI_SIGNING_PRIVATE_KEY: "",
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "file-password",
          ZTIDAL_SIGNING_KEY_FILE: "/secure/fallback.key",
        },
        keyFile: "/secure/cli.key",
        readFile: (path) =>
          path === "/secure/cli.key" ? "  cli-secret\n" : "wrong-secret",
      }),
    ).toEqual({ privateKey: "cli-secret", password: "file-password" });
    expect(
      resolveSigningKey({
        environment: { ZTIDAL_SIGNING_KEY_FILE: "/secure/fallback.key" },
        keyFile: null,
        readFile: (path) =>
          path === "/secure/fallback.key" ? "fallback-secret\n" : "wrong-secret",
      }),
    ).toEqual({ privateKey: "fallback-secret", password: "" });
  });

  it("fails closed when no key source exists or the selected key file is empty", () => {
    expect(() =>
      finalizer.resolveSigningKey({
        environment: {},
        keyFile: null,
        readFile: () => "unused",
      }),
    ).toThrow("no signing key");
    expect(() =>
      finalizer.resolveSigningKey({
        environment: {},
        keyFile: "/secure/empty.key",
        readFile: () => " \n",
      }),
    ).toThrow("signing key file /secure/empty.key is empty");
  });
});

describe("generated combined updater metadata", () => {
  const version = "0.0.36";
  const repo = "ztidal/ZtidalCode-dist";
  const notes = "Mac and Windows release";
  const layout = finalizer.createReleaseLayout({
    repoRoot: "/repo",
    productName: "ZtidalCode",
    version,
  });
  const releaseEntries = [layout.windows[0], layout.windows[2], ...layout.mac];
  const bytesByName = Object.fromEntries(
    [layout.rawWindowsExe, ...layout.windows, ...layout.mac].map(({ name }) => [
      name,
      Buffer.from(`bytes:${name}`),
    ]),
  );
  const sha256ByName = Object.fromEntries(
    Object.entries(bytesByName).map(([name, value]) => [
      name,
      createHash("sha256").update(value).digest("hex"),
    ]),
  );
  const signature = (entry) => bytesByName[`${entry.name}.sig`].toString("utf8").trim();
  const download = (name) =>
    `https://github.com/${repo}/releases/download/${layout.tag}/${name}`;
  const manifest = {
    version,
    notes,
    pub_date: "2026-08-22T02:03:04Z",
    platforms: {
      "windows-x86_64-nsis": {
        signature: signature(layout.windows[0]),
        url: download(layout.windows[0].name),
      },
      "windows-x86_64": {
        signature: signature(layout.windows[0]),
        url: download(layout.windows[0].name),
      },
      "windows-x86_64-msi": {
        signature: signature(layout.windows[2]),
        url: download(layout.windows[2].name),
      },
      "darwin-aarch64-app": {
        signature: signature(layout.mac[1]),
        url: download(layout.mac[1].name),
      },
      "darwin-aarch64": {
        signature: signature(layout.mac[1]),
        url: download(layout.mac[1].name),
      },
    },
  };
  const sums = `${releaseEntries
    .map(({ name }) => `${sha256ByName[name]} *${name}`)
    .join("\n")}\n`;

  it("accepts only the exact five platform keys, URLs, signatures, and checksums", () => {
    expect(
      finalizer.validateGeneratedMetadata?.({
        manifest,
        checksumText: sums,
        layout,
        repo,
        notes,
        bytesByName,
        sha256ByName,
      }),
    ).toEqual({
      platformKeys: [
        "darwin-aarch64",
        "darwin-aarch64-app",
        "windows-x86_64",
        "windows-x86_64-msi",
        "windows-x86_64-nsis",
      ],
      checksumNames: releaseEntries.map(({ name }) => name).sort(),
    });
  });

  it("rejects wrong identity, missing fallback keys, stale URLs, signatures, or checksum lines", () => {
    const validate = (overrides = {}) =>
      finalizer.validateGeneratedMetadata?.({
        manifest,
        checksumText: sums,
        layout,
        repo,
        notes,
        bytesByName,
        sha256ByName,
        ...overrides,
      });

    expect(() => validate({ manifest: { ...manifest, version: "0.0.35" } })).toThrow(
      "latest.json version does not match branding version 0.0.36",
    );
    expect(() => validate({ manifest: { ...manifest, notes: "stale" } })).toThrow(
      "latest.json notes do not match --notes-file",
    );
    const { "darwin-aarch64": _removed, ...missingPlatform } = manifest.platforms;
    expect(() => validate({ manifest: { ...manifest, platforms: missingPlatform } })).toThrow(
      "latest.json platform keys do not match combined mode",
    );
    expect(() =>
      validate({
        manifest: {
          ...manifest,
          platforms: {
            ...manifest.platforms,
            "windows-x86_64": {
              ...manifest.platforms["windows-x86_64"],
              url: manifest.platforms["windows-x86_64"].url.replace(layout.tag, "v0.0.35"),
            },
          },
        },
      }),
    ).toThrow("latest.json URL for windows-x86_64 is not the exact release asset URL");
    expect(() =>
      validate({
        manifest: {
          ...manifest,
          platforms: {
            ...manifest.platforms,
            "darwin-aarch64": {
              ...manifest.platforms["darwin-aarch64"],
              signature: "stale-signature",
            },
          },
        },
      }),
    ).toThrow("latest.json signature for darwin-aarch64 does not match the local .sig");
    expect(() => validate({ checksumText: sums.replace(sha256ByName[layout.mac[0].name], "0".repeat(64)) })).toThrow(
      `SHA256SUMS.txt hash does not match ${layout.mac[0].name}`,
    );
    expect(() => validate({ checksumText: `${sums}0${"0".repeat(63)} *extra.zip\n` })).toThrow(
      "SHA256SUMS.txt names do not match the five release artifacts",
    );
  });
});

function makeFinalizationFixture() {
  const repoRoot = "/repo";
  const notesFile = "/handoff/NOTES.md";
  const windowsHandoff = "/handoff/windows-handoff.json";
  const version = "0.0.36";
  const productName = "ZtidalCode";
  const repo = "ztidal/ZtidalCode-dist";
  const notes = "Mac and Windows release";
  const nodeExecutable = "/test/node";
  const layout = finalizer.createReleaseLayout({ repoRoot, productName, version });
  const artifactEntries = [layout.rawWindowsExe, ...layout.windows, ...layout.mac];
  const fileValues = new Map(
    artifactEntries.map(({ name, path }) => [path, Buffer.from(`artifact:${name}`)]),
  );
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const handoff = {
    version,
    sourceSha: expectedSha,
    files: [layout.rawWindowsExe, ...layout.windows].map(({ name, path }) => ({
      name,
      sha256: digest(fileValues.get(path)),
    })),
  };
  const signature = (entry) => fileValues.get(`${entry.path}.sig`).toString("utf8").trim();
  const download = (name) =>
    `https://github.com/${repo}/releases/download/${layout.tag}/${name}`;
  const manifest = {
    version,
    notes,
    pub_date: "2026-08-22T03:04:05Z",
    platforms: {
      "windows-x86_64-nsis": {
        signature: signature(layout.windows[0]),
        url: download(layout.windows[0].name),
      },
      "windows-x86_64": {
        signature: signature(layout.windows[0]),
        url: download(layout.windows[0].name),
      },
      "windows-x86_64-msi": {
        signature: signature(layout.windows[2]),
        url: download(layout.windows[2].name),
      },
      "darwin-aarch64-app": {
        signature: signature(layout.mac[1]),
        url: download(layout.mac[1].name),
      },
      "darwin-aarch64": {
        signature: signature(layout.mac[1]),
        url: download(layout.mac[1].name),
      },
    },
  };
  const checksumEntries = [layout.windows[0], layout.windows[2], ...layout.mac];
  const sums = `${checksumEntries
    .map(({ name, path }) => `${digest(fileValues.get(path))} *${name}`)
    .join("\n")}\n`;
  fileValues.set(
    join(repoRoot, "branding", "ztidalcode.json"),
    JSON.stringify({
      version,
      productName,
      plugins: {
        updater: {
          endpoints: [
            "https://github.com/ztidal/ZtidalCode-dist/releases/latest/download/latest.json",
          ],
        },
      },
    }),
  );
  fileValues.set(notesFile, `  ${notes}\n`);
  fileValues.set(windowsHandoff, JSON.stringify(handoff));
  fileValues.set(layout.metadata[0].path, JSON.stringify(manifest));
  fileValues.set(layout.metadata[1].path, sums);

  const remoteAsset = ({ name, path }) => ({
    name,
    digest: `sha256:${digest(fileValues.get(path))}`,
  });
  const draftWindows = {
    isDraft: true,
    name: `${productName} ${version}`,
    body: notes,
    assets: layout.windows.map(remoteAsset),
  };
  const finalDraft = {
    isDraft: true,
    name: `${productName} ${version}`,
    body: notes,
    assets: [...layout.windows, ...layout.mac, ...layout.metadata].map(remoteAsset),
  };
  const commands = [];
  let viewIndex = 0;
  const ghViews = [draftWindows, draftWindows, finalDraft];
  const gitOutput = new Map([
    ["rev-parse --abbrev-ref HEAD", "hardening\n"],
    ["status --porcelain=v1 --untracked-files=normal", ""],
    ["rev-parse HEAD", `${expectedSha}\n`],
  ]);
  const runCommand = (command, args) => {
    commands.push({ command, args: [...args] });
    if (command === "git") {
      return { status: 0, stdout: gitOutput.get(args.join(" ")) ?? "" };
    }
    if (command === "gh" && args[0] === "release" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify(ghViews[viewIndex++]) };
    }
    return { status: 0, stdout: "" };
  };
  const readFile = (path, encoding) => {
    if (!fileValues.has(path)) throw new Error(`ENOENT: ${path}`);
    const value = fileValues.get(path);
    if (encoding === "utf8" && Buffer.isBuffer(value)) return value.toString("utf8");
    return value;
  };

  return {
    repoRoot,
    notesFile,
    windowsHandoff,
    version,
    productName,
    repo,
    notes,
    nodeExecutable,
    layout,
    fileValues,
    manifest,
    draftWindows,
    finalDraft,
    commands,
    ghViews,
    gitOutput,
    runCommand,
    readFile,
  };
}

function freshBuildHarness(
  fixture,
  { buildStatus = 0, missingMacName = null } = {},
) {
  const freshTargetDir = "/fresh-cargo-target";
  const freshLayout = finalizer.createReleaseLayout({
    repoRoot: fixture.repoRoot,
    productName: fixture.productName,
    version: fixture.version,
    releaseRoot: join(
      freshTargetDir,
      "aarch64-apple-darwin",
      "release",
    ),
    metadataRoot: freshTargetDir,
  });
  const oldManifestText = fixture.fileValues.get(fixture.layout.metadata[0].path);
  const oldChecksumText = fixture.fileValues.get(fixture.layout.metadata[1].path);
  const buildCalls = [];
  const commandCalls = [];
  const removedTargets = [];
  const writtenPaths = [];
  const readPaths = [];

  const runSignedBuild = (command, args, options) => {
    buildCalls.push({ command, args: [...args], options });
    if (buildStatus !== 0) {
      return { status: buildStatus, stdout: "", stderr: "native build failed" };
    }
    for (const [oldEntry, freshEntry] of fixture.layout.mac.map(
      (entry, index) => [entry, freshLayout.mac[index]],
    )) {
      if (freshEntry.name !== missingMacName) {
        fixture.fileValues.set(
          freshEntry.path,
          Buffer.from(fixture.fileValues.get(oldEntry.path)),
        );
      }
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const runCommand = (command, args, options) => {
    commandCalls.push({ command, args: [...args], options });
    const result = fixture.runCommand(command, args);
    if (command === fixture.nodeExecutable) {
      fixture.fileValues.set(freshLayout.metadata[0].path, oldManifestText);
      fixture.fileValues.set(freshLayout.metadata[1].path, oldChecksumText);
    }
    return result;
  };
  const readFile = (path, encoding) => {
    readPaths.push(path);
    return fixture.readFile(path, encoding);
  };
  const writeFile = (path, bytes) => {
    writtenPaths.push(path);
    fixture.fileValues.set(path, Buffer.from(bytes));
  };

  return {
    freshTargetDir,
    freshLayout,
    buildCalls,
    commandCalls,
    removedTargets,
    writtenPaths,
    readPaths,
    options: {
      runCommand,
      runSignedBuild,
      readFile,
      writeFile,
      makeTempDir: () => freshTargetDir,
      removeTempDir: (path) => removedTargets.push(path),
      environment: {
        GH_TOKEN: "github-token",
        TAURI_SIGNING_PRIVATE_KEY: "mac-signing-secret",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "mac-signing-password",
      },
    },
  };
}

function finalizationOptions(fixture, harness) {
  return {
    repoRoot: fixture.repoRoot,
    expectedSha,
    windowsHandoff: fixture.windowsHandoff,
    notesFile: fixture.notesFile,
    nodeExecutable: fixture.nodeExecutable,
    log: () => {},
    ...harness.options,
  };
}

describe("fail-closed draft finalization state machine", () => {
  it("builds Mac once from expectedSha in a fresh target and never reads a prebuilt Mac bundle", () => {
    const fixture = makeFinalizationFixture();
    const harness = freshBuildHarness(fixture);

    const result = finalizer.finalizeReleaseDraft?.({
      repoRoot: fixture.repoRoot,
      expectedSha,
      windowsHandoff: fixture.windowsHandoff,
      notesFile: fixture.notesFile,
      nodeExecutable: fixture.nodeExecutable,
      log: () => {},
      ...harness.options,
    });

    expect(result?.uploaded).toEqual(
      [...harness.freshLayout.mac, ...harness.freshLayout.metadata].map(
        ({ name }) => name,
      ),
    );
    expect(harness.buildCalls).toHaveLength(1);
    expect(harness.buildCalls[0]).toMatchObject({
      command: "npm",
      args: [
        "run",
        "tauri",
        "--",
        "build",
        "--config",
        "branding/ztidalcode.json",
        "--target",
        "aarch64-apple-darwin",
      ],
      options: {
        cwd: fixture.repoRoot,
        env: {
          CARGO_TARGET_DIR: harness.freshTargetDir,
          TAURI_SIGNING_PRIVATE_KEY: "mac-signing-secret",
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "mac-signing-password",
        },
      },
    });
    expect(
      harness.readPaths.filter((path) =>
        fixture.layout.mac.some((entry) => entry.path === path),
      ),
    ).toEqual([]);
    expect(harness.writtenPaths.sort()).toEqual(
      [
        harness.freshLayout.rawWindowsExe,
        ...harness.freshLayout.windows,
      ]
        .map(({ path }) => path)
        .sort(),
    );
    const upload = harness.commandCalls.find(
      ({ command, args }) => command === "gh" && args[1] === "upload",
    );
    expect(upload?.args).toEqual([
      "release",
      "upload",
      harness.freshLayout.tag,
      ...harness.freshLayout.mac.map(({ path }) => path),
      ...harness.freshLayout.metadata.map(({ path }) => path),
      "--repo",
      fixture.repo,
    ]);
    expect(harness.removedTargets).toEqual([harness.freshTargetDir]);

    const nonBuildCalls = harness.commandCalls;
    for (const { args, options } of nonBuildCalls) {
      expect(args).not.toContain("mac-signing-secret");
      expect(options?.env?.TAURI_SIGNING_PRIVATE_KEY).toBeUndefined();
      expect(options?.env?.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBeUndefined();
      expect(options?.env?.GH_TOKEN).toBe("github-token");
    }
  });

  it("cleans the fresh target and never mutates GitHub when the build fails or omits a Mac artifact", () => {
    for (const testCase of [
      {
        options: { buildStatus: 9 },
        message: "fresh arm64 Mac build failed with exit code 9: native build failed",
      },
      {
        options: { missingMacName: "ZtidalCode.app.tar.gz" },
        message: "cannot read local artifact ZtidalCode.app.tar.gz",
      },
    ]) {
      const fixture = makeFinalizationFixture();
      const harness = freshBuildHarness(fixture, testCase.options);

      expect(() =>
        finalizer.finalizeReleaseDraft?.({
          repoRoot: fixture.repoRoot,
          expectedSha,
          windowsHandoff: fixture.windowsHandoff,
          notesFile: fixture.notesFile,
          nodeExecutable: fixture.nodeExecutable,
          log: () => {},
          ...harness.options,
        }),
      ).toThrow(testCase.message);
      expect(harness.removedTargets).toEqual([harness.freshTargetDir]);
      expect(
        harness.commandCalls.some(
          ({ command, args }) =>
            command === "gh" && ["upload", "edit"].includes(args[1]),
        ),
      ).toBe(false);
    }
  });

  it("redacts the signing key and password from native-build failures", () => {
    const fixture = makeFinalizationFixture();
    const harness = freshBuildHarness(fixture);
    harness.options.runSignedBuild = () => ({
      status: 9,
      stdout: "",
      stderr:
        "failed with mac-signing-secret and mac-signing-password in diagnostics",
    });

    let failure;
    try {
      finalizer.finalizeReleaseDraft?.(finalizationOptions(fixture, harness));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain("[REDACTED]");
    expect(failure?.message).not.toContain("mac-signing-secret");
    expect(failure?.message).not.toContain("mac-signing-password");
    expect(harness.removedTargets).toEqual([harness.freshTargetDir]);
  });

  it("preflights, verifies twice, uploads five files without clobber, edits, and postchecks nine", () => {
    const fixture = makeFinalizationFixture();
    const harness = freshBuildHarness(fixture);
    const result = finalizer.finalizeReleaseDraft?.(
      finalizationOptions(fixture, harness),
    );

    expect(result).toEqual({
      version: fixture.version,
      tag: fixture.layout.tag,
      repo: fixture.repo,
      uploaded: [...fixture.layout.mac, ...fixture.layout.metadata].map(({ name }) => name),
      assetNames: [...fixture.layout.finalAssetNames].sort(),
      isDraft: true,
    });
    const viewArgs = [
      "release",
      "view",
      fixture.layout.tag,
      "--repo",
      fixture.repo,
      "--json",
      "isDraft,name,body,assets",
    ];
    expect(fixture.commands).toEqual([
      { command: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"] },
      {
        command: "git",
        args: ["status", "--porcelain=v1", "--untracked-files=normal"],
      },
      { command: "git", args: ["rev-parse", "HEAD"] },
      { command: "gh", args: viewArgs },
      { command: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"] },
      {
        command: "git",
        args: ["status", "--porcelain=v1", "--untracked-files=normal"],
      },
      { command: "git", args: ["rev-parse", "HEAD"] },
      {
        command: fixture.nodeExecutable,
        args: [
          join(fixture.repoRoot, "scripts", "make-updater-json.mjs"),
          "--mode",
          "combined",
          "--notes",
          fixture.notes,
          "--tag",
          fixture.layout.tag,
          "--bundle-dir",
          harness.freshLayout.bundleDir,
          "--exe",
          harness.freshLayout.rawWindowsExe.path,
          "--out",
          harness.freshLayout.metadata[0].path,
        ],
      },
      { command: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"] },
      {
        command: "git",
        args: ["status", "--porcelain=v1", "--untracked-files=normal"],
      },
      { command: "git", args: ["rev-parse", "HEAD"] },
      { command: "gh", args: viewArgs },
      {
        command: "gh",
        args: [
          "release",
          "upload",
          fixture.layout.tag,
          ...harness.freshLayout.mac.map(({ path }) => path),
          ...harness.freshLayout.metadata.map(({ path }) => path),
          "--repo",
          fixture.repo,
        ],
      },
      {
        command: "gh",
        args: [
          "release",
          "edit",
          fixture.layout.tag,
          "--repo",
          fixture.repo,
          "--title",
          "ZtidalCode 0.0.36",
          "--notes",
          fixture.notes,
        ],
      },
      { command: "gh", args: viewArgs },
    ]);
    const allArgs = fixture.commands.flatMap(({ args }) => args);
    expect(allArgs).not.toContain("--clobber");
    expect(allArgs).not.toContain("--draft=false");
    expect(
      fixture.commands.find(({ command, args }) =>
        command === "gh" && args[1] === "upload",
      )?.args,
    ).not.toContain(harness.freshLayout.rawWindowsExe.path);
    expect(harness.removedTargets).toEqual([harness.freshTargetDir]);
  });

  it("stops before any GitHub mutation when the second draft check changes", () => {
    const fixture = makeFinalizationFixture();
    fixture.ghViews[1] = { ...fixture.draftWindows, isDraft: false };
    const harness = freshBuildHarness(fixture);

    expect(() =>
      finalizer.finalizeReleaseDraft?.(finalizationOptions(fixture, harness)),
    ).toThrow("immediately before upload: release is not a draft");
    expect(
      fixture.commands.some(
        ({ command, args }) =>
          command === "gh" && ["upload", "edit"].includes(args[1]),
      ),
    ).toBe(false);
  });

  it("binds remote Windows digests to the handoff at both pre-upload checks", () => {
    for (const [viewIndex, phase] of [
      [0, "before finalization"],
      [1, "immediately before upload"],
    ]) {
      const fixture = makeFinalizationFixture();
      fixture.ghViews[viewIndex] = {
        ...fixture.draftWindows,
        assets: fixture.draftWindows.assets.map((asset, index) =>
          index === 0
            ? { ...asset, digest: `sha256:${"f".repeat(64)}` }
            : asset,
        ),
      };
      const harness = freshBuildHarness(fixture);

      expect(() =>
        finalizer.finalizeReleaseDraft?.(finalizationOptions(fixture, harness)),
      ).toThrow(
        `${phase}: SHA256 mismatch for remote asset ${fixture.layout.windows[0].name}`,
      );
      expect(
        fixture.commands.some(
          ({ command, args }) =>
            command === "gh" && ["upload", "edit"].includes(args[1]),
        ),
      ).toBe(false);
    }
  });

  it("rechecks the external notes immediately before upload", () => {
    const fixture = makeFinalizationFixture();
    const baseRun = fixture.runCommand;
    let viewCount = 0;
    fixture.runCommand = (command, args) => {
      const result = baseRun(command, args);
      if (command === "gh" && args[0] === "release" && args[1] === "view") {
        viewCount += 1;
        if (viewCount === 2) {
          fixture.fileValues.set(fixture.notesFile, "changed just before upload\n");
        }
      }
      return result;
    };
    const harness = freshBuildHarness(fixture);

    expect(() =>
      finalizer.finalizeReleaseDraft?.(finalizationOptions(fixture, harness)),
    ).toThrow("--notes-file changed during finalization");
    expect(
      fixture.commands.some(
        ({ command, args }) =>
          command === "gh" && ["upload", "edit"].includes(args[1]),
      ),
    ).toBe(false);
  });

  it("postchecks all remote digests plus the exact release title and body", () => {
    const cases = [
      {
        mutate(release, fixture) {
          release.assets.find(
            ({ name }) => name === fixture.layout.windows[0].name,
          ).digest = `sha256:${"f".repeat(64)}`;
        },
        message: "after finalization: SHA256 mismatch for remote asset ZtidalCode_0.0.36_x64-setup.exe",
      },
      {
        mutate(release) {
          release.assets.find(({ name }) => name === "latest.json").digest =
            `sha256:${"f".repeat(64)}`;
        },
        message: "after finalization: SHA256 mismatch for remote asset latest.json",
      },
      {
        mutate(release) {
          release.name = "Wrong title";
        },
        message: "after finalization: release name does not match ZtidalCode 0.0.36",
      },
      {
        mutate(release) {
          release.body = "stale release notes";
        },
        message: "after finalization: release body does not match release notes",
      },
    ];

    for (const testCase of cases) {
      const fixture = makeFinalizationFixture();
      const finalDraft = structuredClone(fixture.finalDraft);
      testCase.mutate(finalDraft, fixture);
      fixture.ghViews[2] = finalDraft;
      const harness = freshBuildHarness(fixture);

      expect(() =>
        finalizer.finalizeReleaseDraft?.(finalizationOptions(fixture, harness)),
      ).toThrow(testCase.message);
      expect(
        fixture.commands.some(
          ({ command, args }) => command === "gh" && args.includes("--draft=false"),
        ),
      ).toBe(false);
    }
  });

  it("stops at branch, cleanliness, or full-SHA mismatch before reading release inputs", () => {
    const cases = [
      {
        key: "rev-parse --abbrev-ref HEAD",
        value: "main\n",
        message: "releases must be finalized from hardening; current branch is main",
      },
      {
        key: "status --porcelain=v1 --untracked-files=normal",
        value: " M src/main.ts\n",
        message: "working tree must be clean before draft finalization",
      },
      {
        key: "rev-parse HEAD",
        value: `${"f".repeat(40)}\n`,
        message: "HEAD does not match --expected-sha",
      },
    ];
    for (const testCase of cases) {
      const fixture = makeFinalizationFixture();
      fixture.gitOutput.set(testCase.key, testCase.value);
      expect(() =>
        finalizer.finalizeReleaseDraft?.({
          repoRoot: fixture.repoRoot,
          expectedSha,
          windowsHandoff: fixture.windowsHandoff,
          notesFile: fixture.notesFile,
          runCommand: fixture.runCommand,
          readFile: () => {
            throw new Error("release input read too early");
          },
          nodeExecutable: fixture.nodeExecutable,
          log: () => {},
        }),
      ).toThrow(testCase.message);
      expect(
        fixture.commands.some(
          ({ command, args }) =>
            command === "gh" || (command === fixture.nodeExecutable && args.length > 0),
        ),
      ).toBe(false);
    }
  });

  it("treats a failed external command as fatal and never advances to upload", () => {
    const fixture = makeFinalizationFixture();
    const baseRun = fixture.runCommand;
    fixture.runCommand = (command, args) => {
      if (command === fixture.nodeExecutable) {
        fixture.commands.push({ command, args: [...args] });
        return { status: 7, stdout: "", stderr: "signature verification failed\n" };
      }
      return baseRun(command, args);
    };
    const harness = freshBuildHarness(fixture);

    expect(() =>
      finalizer.finalizeReleaseDraft?.(finalizationOptions(fixture, harness)),
    ).toThrow("make-updater-json failed with exit code 7: signature verification failed");
    expect(
      fixture.commands.some(
        ({ command, args }) => command === "gh" && args[1] === "upload",
      ),
    ).toBe(false);
    expect(harness.removedTargets).toEqual([harness.freshTargetDir]);
  });

  it("rechecks source, ignored artifacts, and release notes after metadata generation", () => {
    for (const changedInput of [
      "raw Windows executable",
      "release notes",
      "source checkout",
    ]) {
      const fixture = makeFinalizationFixture();
      const baseRun = fixture.runCommand;
      fixture.runCommand = (command, args) => {
        const result = baseRun(command, args);
        if (command === fixture.nodeExecutable) {
          if (changedInput === "raw Windows executable") {
            fixture.fileValues.set(
              fixture.layout.rawWindowsExe.path,
              Buffer.from("changed after initial verification"),
            );
          } else {
            if (changedInput === "release notes") {
              fixture.fileValues.set(fixture.notesFile, "changed release notes\n");
            } else {
              fixture.gitOutput.set(
                "status --porcelain=v1 --untracked-files=normal",
                " M scripts/make-updater-json.mjs\n",
              );
            }
          }
        }
        return result;
      };
      const harness = freshBuildHarness(fixture);

      expect(() =>
        finalizer.finalizeReleaseDraft?.(finalizationOptions(fixture, harness)),
      ).toThrow(
        changedInput === "raw Windows executable"
          ? "SHA256 mismatch for PinkCode.exe"
          : changedInput === "release notes"
            ? "--notes-file changed during finalization"
            : "working tree must be clean before draft finalization",
      );
      expect(
        fixture.commands.some(
          ({ command, args }) => command === "gh" && args[1] === "upload",
        ),
      ).toBe(false);
    }
  });
});
