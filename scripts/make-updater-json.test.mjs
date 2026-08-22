import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const sourceScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "make-updater-json.mjs",
);
const temporaryRepos = [];

afterEach(() => {
  for (const path of temporaryRepos.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = Buffer.from("0102030405060708", "hex");
  const der = publicKey.export({ format: "der", type: "spki" });
  const keyLine = Buffer.concat([
    Buffer.from("Ed", "latin1"),
    keyId,
    der.subarray(-32),
  ]).toString("base64");
  const text = `untrusted comment: test public key\n${keyLine}\n`;
  return {
    keyId,
    privateKey,
    encodedPublicKey: Buffer.from(text, "utf8").toString("base64"),
  };
}

function updaterSignature(bytes, filename, key) {
  const fileSignature = sign(null, bytes, key.privateKey);
  const signatureLine = Buffer.concat([
    Buffer.from("Ed", "latin1"),
    key.keyId,
    fileSignature,
  ]).toString("base64");
  const trustedComment = `timestamp:1 file:${filename}`;
  const globalSignature = sign(
    null,
    Buffer.concat([fileSignature, Buffer.from(trustedComment, "utf8")]),
    key.privateKey,
  ).toString("base64");
  const minisign =
    `untrusted comment: test signature\n${signatureLine}\n` +
    `trusted comment: ${trustedComment}\n${globalSignature}\n`;
  return `${Buffer.from(minisign, "utf8").toString("base64")}\n`;
}

function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function makeMachOBinary(cpuType, pubkey) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpuType, 4);
  return Buffer.concat([header, Buffer.from(pubkey, "utf8")]);
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000755\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function gzipTar(entries) {
  const chunks = [];
  for (const [name, value] of entries) {
    const bytes = Buffer.from(value);
    chunks.push(tarHeader(name, bytes.length), bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function appInfoPlist(version) {
  return (
    `<?xml version="1.0"?><plist><dict>` +
    `<key>CFBundleShortVersionString</key><string>${version}</string>` +
    `</dict></plist>`
  );
}

function appArchive({ version, cpuType, pubkey }) {
  return gzipTar([
    ["ZtidalCode.app/Contents/Info.plist", appInfoPlist(version)],
    [
      "ZtidalCode.app/Contents/MacOS/PinkCode",
      makeMachOBinary(cpuType, pubkey),
    ],
  ]);
}

function signedBundle(path, bytes, key) {
  write(path, bytes);
  write(`${path}.sig`, updaterSignature(bytes, basename(path), key));
}

function prepareReleaseTree() {
  const root = mkdtempSync(join(tmpdir(), "ztidal-updater-test-"));
  temporaryRepos.push(root);
  const repo = join(root, "repo");
  const bundle = join(root, "bundle");
  const output = join(root, "output", "latest.json");
  const key = makeKey();
  const upstreamKey = makeKey();

  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(sourceScript, join(repo, "scripts", "make-updater-json.mjs"));
  write(
    join(repo, "branding", "ztidalcode.json"),
    JSON.stringify({
      productName: "ZtidalCode",
      identifier: "com.ztidal.code",
      version: "9.8.7",
      plugins: {
        updater: {
          pubkey: key.encodedPublicKey,
          endpoints: [
            "https://github.com/ztidal/ZtidalCode-dist/releases/latest/download/latest.json",
          ],
        },
      },
    }),
  );
  write(
    join(repo, "src-tauri", "tauri.conf.json"),
    JSON.stringify({
      productName: "PinkCode",
      mainBinaryName: "PinkCode",
      plugins: { updater: { pubkey: upstreamKey.encodedPublicKey } },
    }),
  );

  const nsisName = "ZtidalCode_9.8.7_x64-setup.exe";
  const msiName = "ZtidalCode_9.8.7_x64_en-US.msi";
  signedBundle(join(bundle, "nsis", nsisName), Buffer.from("nsis"), key);
  signedBundle(join(bundle, "msi", msiName), Buffer.from("msi"), key);
  write(join(root, "PinkCode.exe"), Buffer.from(`exe:${key.encodedPublicKey}`));

  const archiveName = "ZtidalCode.app.tar.gz";
  const archiveBytes = appArchive({
    version: "9.8.7",
    cpuType: 0x0100000c,
    pubkey: key.encodedPublicKey,
  });
  const archivePath = join(bundle, "macos", archiveName);
  signedBundle(archivePath, archiveBytes, key);
  const dmgName = "ZtidalCode_9.8.7_aarch64.dmg";
  const dmgBytes = Buffer.from("mac installer image");
  write(join(bundle, "dmg", dmgName), dmgBytes);
  const macBinaryPath = join(
    bundle,
    "macos",
    "ZtidalCode.app",
    "Contents",
    "MacOS",
    "PinkCode",
  );
  write(macBinaryPath, makeMachOBinary(0x0100000c, key.encodedPublicKey));
  const macInfoPlistPath = join(
    bundle,
    "macos",
    "ZtidalCode.app",
    "Contents",
    "Info.plist",
  );
  write(
    macInfoPlistPath,
    appInfoPlist("9.8.7"),
  );

  return {
    root,
    repo,
    bundle,
    output,
    key,
    archiveName,
    archivePath,
    archiveBytes,
    archiveSignature: readFileSync(`${archivePath}.sig`, "utf8"),
    dmgName,
    dmgBytes,
    nsisName,
    msiName,
  };
}

function runGenerator(fixture) {
  return spawnSync(
    process.execPath,
    [
      join(fixture.repo, "scripts", "make-updater-json.mjs"),
      "--bundle-dir",
      fixture.bundle,
      "--out",
      fixture.output,
      "--notes",
      "Settings are easier to find.",
      "--pub-date",
      "2026-08-22T00:00:00Z",
    ],
    { encoding: "utf8" },
  );
}

function replaceSignedArchive(fixture, options) {
  const bytes = appArchive(options);
  write(fixture.archivePath, bytes);
  write(
    `${fixture.archivePath}.sig`,
    updaterSignature(bytes, fixture.archiveName, fixture.key),
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("make-updater-json macOS release support", () => {
  it("keeps the existing Windows-only platform and checksum contract", () => {
    const fixture = prepareReleaseTree();
    rmSync(join(fixture.bundle, "macos"), { recursive: true });
    rmSync(join(fixture.bundle, "dmg"), { recursive: true });

    const result = runGenerator(fixture);

    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(fixture.output, "utf8"));
    expect(Object.keys(manifest.platforms)).toEqual([
      "windows-x86_64-nsis",
      "windows-x86_64",
      "windows-x86_64-msi",
    ]);
    expect(
      readFileSync(join(dirname(fixture.output), "SHA256SUMS.txt"), "utf8")
        .trim()
        .split("\n"),
    ).toEqual([
      `${sha256(Buffer.from("nsis"))} *${fixture.nsisName}`,
      `${sha256(Buffer.from("msi"))} *${fixture.msiName}`,
    ]);
  });

  it("adds arm64 app aliases while preserving the three Windows keys", () => {
    const fixture = prepareReleaseTree();

    const result = runGenerator(fixture);

    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(fixture.output, "utf8"));
    expect(Object.keys(manifest.platforms)).toEqual([
      "windows-x86_64-nsis",
      "windows-x86_64",
      "windows-x86_64-msi",
      "darwin-aarch64-app",
      "darwin-aarch64",
    ]);
    const archiveUrl =
      "https://github.com/ztidal/ZtidalCode-dist/releases/download/" +
      "v9.8.7/ZtidalCode.app.tar.gz";
    expect(manifest.platforms["darwin-aarch64-app"]).toEqual({
      signature: fixture.archiveSignature.trim(),
      url: archiveUrl,
    });
    expect(manifest.platforms["darwin-aarch64"]).toEqual(
      manifest.platforms["darwin-aarch64-app"],
    );

    const sums = readFileSync(join(dirname(fixture.output), "SHA256SUMS.txt"), "utf8")
      .trim()
      .split("\n");
    expect(sums).toEqual([
      `${sha256(Buffer.from("nsis"))} *${fixture.nsisName}`,
      `${sha256(Buffer.from("msi"))} *${fixture.msiName}`,
      `${sha256(fixture.dmgBytes)} *${fixture.dmgName}`,
      `${sha256(fixture.archiveBytes)} *${fixture.archiveName}`,
      `${sha256(Buffer.from(fixture.archiveSignature, "utf8"))} *${fixture.archiveName}.sig`,
    ]);
  });

  it("rejects a macOS archive whose updater signature is stale", () => {
    const fixture = prepareReleaseTree();
    write(fixture.archivePath, Buffer.from("archive changed after signing"));

    const result = runGenerator(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "ZtidalCode.app.tar.gz: signature does not match the bundle bytes",
    );
  });

  it("refuses to label an x86_64 app archive as darwin-aarch64", () => {
    const fixture = prepareReleaseTree();
    replaceSignedArchive(fixture, {
      version: "9.8.7",
      cpuType: 0x01000007,
      pubkey: fixture.key.encodedPublicKey,
    });

    const result = runGenerator(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "PinkCode is not a thin arm64 Mach-O executable",
    );
  });

  it("checks the Mac app binary was built through the branding overlay", () => {
    const fixture = prepareReleaseTree();
    replaceSignedArchive(fixture, {
      version: "9.8.7",
      cpuType: 0x0100000c,
      pubkey: "binary without the configured updater key",
    });

    const result = runGenerator(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "PinkCode does not carry our updater key",
    );
  });

  it("can generate a Mac-only manifest from the three public assets", () => {
    const fixture = prepareReleaseTree();
    rmSync(join(fixture.bundle, "nsis"), { recursive: true });
    rmSync(join(fixture.bundle, "msi"), { recursive: true });
    rmSync(join(fixture.root, "PinkCode.exe"));
    rmSync(join(fixture.bundle, "macos", "ZtidalCode.app"), {
      recursive: true,
    });

    const result = runGenerator(fixture);

    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(fixture.output, "utf8"));
    expect(Object.keys(manifest.platforms)).toEqual([
      "darwin-aarch64-app",
      "darwin-aarch64",
    ]);
    expect(
      readFileSync(join(dirname(fixture.output), "SHA256SUMS.txt"), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.slice(line.indexOf("*") + 1)),
    ).toEqual([
      fixture.dmgName,
      fixture.archiveName,
      `${fixture.archiveName}.sig`,
    ]);
  });

  it("does not silently publish Windows-only when the Mac asset set is incomplete", () => {
    const fixture = prepareReleaseTree();
    rmSync(fixture.archivePath);

    const result = runGenerator(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "ZtidalCode.app.tar.gz is missing",
    );
  });

  it("does not ignore a Windows provenance handoff missing both installers", () => {
    const fixture = prepareReleaseTree();
    rmSync(join(fixture.bundle, "nsis"), { recursive: true });
    rmSync(join(fixture.bundle, "msi"), { recursive: true });

    const result = runGenerator(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "no -setup.exe bundle",
    );
  });

  it("rejects an app bundle built for a different release version", () => {
    const fixture = prepareReleaseTree();
    replaceSignedArchive(fixture, {
      version: "9.8.6",
      cpuType: 0x0100000c,
      pubkey: fixture.key.encodedPublicKey,
    });

    const result = runGenerator(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Mac app version is 9.8.6, but branding version is 9.8.7",
    );
  });
});
