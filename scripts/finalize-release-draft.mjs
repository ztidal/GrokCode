import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "..");

export function parseFinalizeArgs(argv) {
  if (argv.includes("--help")) {
    if (argv.length !== 1) throw new Error("--help cannot be combined with other arguments");
    return { help: true };
  }

  const required = new Set([
    "--expected-sha",
    "--windows-handoff",
    "--notes-file",
  ]);
  const allowed = new Set([...required, "--key"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    if (!allowed.has(token)) throw new Error(`unknown flag ${token}`);
    if (values.has(token)) throw new Error(`duplicate flag ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`${token} needs a value`);
    }
    values.set(token, value);
    index += 1;
  }

  for (const flag of required) {
    if (!values.has(flag)) throw new Error(`${flag} is required`);
  }
  const expectedSha = values.get("--expected-sha");
  if (!/^[0-9a-f]{40}$/i.test(expectedSha)) {
    throw new Error("--expected-sha must be exactly 40 hexadecimal characters");
  }

  return {
    expectedSha: expectedSha.toLowerCase(),
    windowsHandoff: values.get("--windows-handoff"),
    notesFile: values.get("--notes-file"),
    keyFile: values.get("--key") ?? null,
    help: false,
  };
}

function assertRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function unexpectedKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).filter((key) => !allowed.has(key)).sort();
}

function sameStringSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.every((value, index) => value === right[index]);
}

export function createReleaseLayout({
  repoRoot,
  productName,
  version,
  releaseRoot: releaseRootOverride = null,
  metadataRoot = repoRoot,
}) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new Error("repoRoot must be a non-empty string");
  }
  if (typeof productName !== "string" || productName.length === 0) {
    throw new Error("productName must be a non-empty string");
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("branding version must use numeric major.minor.patch format");
  }
  if (
    releaseRootOverride !== null &&
    (typeof releaseRootOverride !== "string" || releaseRootOverride.length === 0)
  ) {
    throw new Error("releaseRoot must be null or a non-empty string");
  }
  if (typeof metadataRoot !== "string" || metadataRoot.length === 0) {
    throw new Error("metadataRoot must be a non-empty string");
  }

  const releaseRoot =
    releaseRootOverride ?? join(repoRoot, "src-tauri", "target", "release");
  const bundleDir = join(releaseRoot, "bundle");
  const rawWindowsExe = {
    name: "PinkCode.exe",
    path: join(releaseRoot, "PinkCode.exe"),
  };
  const windows = [
    {
      name: `${productName}_${version}_x64-setup.exe`,
      path: join(bundleDir, "nsis", `${productName}_${version}_x64-setup.exe`),
    },
    {
      name: `${productName}_${version}_x64-setup.exe.sig`,
      path: join(bundleDir, "nsis", `${productName}_${version}_x64-setup.exe.sig`),
    },
    {
      name: `${productName}_${version}_x64_en-US.msi`,
      path: join(bundleDir, "msi", `${productName}_${version}_x64_en-US.msi`),
    },
    {
      name: `${productName}_${version}_x64_en-US.msi.sig`,
      path: join(bundleDir, "msi", `${productName}_${version}_x64_en-US.msi.sig`),
    },
  ];
  const mac = [
    {
      name: `${productName}_${version}_aarch64.dmg`,
      path: join(bundleDir, "dmg", `${productName}_${version}_aarch64.dmg`),
    },
    {
      name: `${productName}.app.tar.gz`,
      path: join(bundleDir, "macos", `${productName}.app.tar.gz`),
    },
    {
      name: `${productName}.app.tar.gz.sig`,
      path: join(bundleDir, "macos", `${productName}.app.tar.gz.sig`),
    },
  ];
  const metadata = [
    { name: "latest.json", path: join(metadataRoot, "latest.json") },
    { name: "SHA256SUMS.txt", path: join(metadataRoot, "SHA256SUMS.txt") },
  ];

  return {
    tag: `v${version}`,
    releaseRoot,
    bundleDir,
    rawWindowsExe,
    windows,
    mac,
    metadata,
    handoffNames: [rawWindowsExe.name, ...windows.map(({ name }) => name)],
    draftWindowsNames: windows.map(({ name }) => name),
    finalAssetNames: [
      ...windows.map(({ name }) => name),
      ...mac.map(({ name }) => name),
      ...metadata.map(({ name }) => name),
    ],
  };
}

export function validateWindowsHandoff(
  handoff,
  { version, expectedSha, expectedNames },
) {
  assertRecord(handoff, "handoff");
  const extras = unexpectedKeys(handoff, ["version", "sourceSha", "files"]);
  if (extras.length > 0) {
    throw new Error(`handoff has unexpected keys: ${extras.join(", ")}`);
  }
  const missing = ["version", "sourceSha", "files"].filter(
    (key) => !Object.hasOwn(handoff, key),
  );
  if (missing.length > 0) {
    throw new Error(`handoff is missing keys: ${missing.join(", ")}`);
  }
  if (handoff.version !== version) {
    throw new Error(
      `handoff version ${String(handoff.version)} does not match branding version ${version}`,
    );
  }
  if (!/^[0-9a-f]{40}$/i.test(handoff.sourceSha)) {
    throw new Error("handoff sourceSha must be exactly 40 hexadecimal characters");
  }
  if (handoff.sourceSha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error("handoff sourceSha does not match --expected-sha");
  }
  if (!Array.isArray(handoff.files) || handoff.files.length !== 5) {
    throw new Error("handoff must list exactly 5 files");
  }

  const byName = new Map();
  for (const file of handoff.files) {
    assertRecord(file, "handoff file");
    const fileExtras = unexpectedKeys(file, ["name", "sha256"]);
    const displayName = typeof file.name === "string" ? file.name : "<unnamed>";
    if (fileExtras.length > 0) {
      throw new Error(
        `handoff file ${displayName} has unexpected keys: ${fileExtras.join(", ")}`,
      );
    }
    const missingFileKeys = ["name", "sha256"].filter(
      (key) => !Object.hasOwn(file, key),
    );
    if (missingFileKeys.length > 0) {
      throw new Error(
        `handoff file ${displayName} is missing keys: ${missingFileKeys.join(", ")}`,
      );
    }
    if (typeof file.name !== "string" || file.name.length === 0) {
      throw new Error("handoff file name must be a non-empty string");
    }
    if (byName.has(file.name)) {
      throw new Error(`handoff contains duplicate file ${file.name}`);
    }
    if (!/^[0-9a-f]{64}$/i.test(file.sha256)) {
      throw new Error(
        `handoff SHA256 for ${file.name} must be 64 hexadecimal characters`,
      );
    }
    byName.set(file.name, { name: file.name, sha256: file.sha256.toLowerCase() });
  }

  if (!sameStringSet([...byName.keys()], expectedNames)) {
    throw new Error("handoff file names do not match the expected Windows handoff");
  }

  return {
    version,
    sourceSha: handoff.sourceSha.toLowerCase(),
    files: expectedNames.map((name) => byName.get(name)),
  };
}

export function validateDraftState(
  release,
  expectedAssets,
  phase,
  expectedRelease = null,
) {
  assertRecord(release, `${phase}: release`);
  if (release.isDraft !== true) {
    throw new Error(`${phase}: release is not a draft`);
  }
  if (expectedRelease) {
    if (release.name !== expectedRelease.name) {
      throw new Error(
        `${phase}: release name does not match ${expectedRelease.name}`,
      );
    }
    if (release.body !== expectedRelease.body) {
      throw new Error(`${phase}: release body does not match release notes`);
    }
  }
  if (!Array.isArray(release.assets)) {
    throw new Error(`${phase}: release assets must be an array`);
  }
  if (!Array.isArray(expectedAssets)) {
    throw new Error(`${phase}: expected assets must be an array`);
  }

  const expectedByName = new Map();
  for (const asset of expectedAssets) {
    assertRecord(asset, `${phase}: expected asset`);
    if (typeof asset.name !== "string" || asset.name.length === 0) {
      throw new Error(`${phase}: expected asset name must be a non-empty string`);
    }
    if (!/^[0-9a-f]{64}$/.test(asset.sha256 ?? "")) {
      throw new Error(`${phase}: expected SHA256 for ${asset.name} is invalid`);
    }
    if (expectedByName.has(asset.name)) {
      throw new Error(`${phase}: duplicate expected asset ${asset.name}`);
    }
    expectedByName.set(asset.name, asset.sha256);
  }

  const names = [];
  const seen = new Set();
  const remoteHashes = new Map();
  for (const asset of release.assets) {
    assertRecord(asset, `${phase}: release asset`);
    if (typeof asset.name !== "string" || asset.name.length === 0) {
      throw new Error(`${phase}: release asset name must be a non-empty string`);
    }
    if (seen.has(asset.name)) {
      throw new Error(`${phase}: duplicate asset ${asset.name}`);
    }
    seen.add(asset.name);
    names.push(asset.name);
    if (!/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? "")) {
      throw new Error(
        `${phase}: asset ${asset.name} digest must be sha256:<64 lowercase hex>`,
      );
    }
    remoteHashes.set(asset.name, asset.digest.slice("sha256:".length));
  }

  const expectedAssetNames = [...expectedByName.keys()];
  if (!sameStringSet(names, expectedAssetNames)) {
    throw new Error(
      `${phase}: asset set does not match; expected ${JSON.stringify(
        [...expectedAssetNames].sort(),
      )}, got ${JSON.stringify([...names].sort())}`,
    );
  }
  for (const [name, expectedHash] of expectedByName) {
    if (remoteHashes.get(name) !== expectedHash) {
      throw new Error(`${phase}: SHA256 mismatch for remote asset ${name}`);
    }
  }
  return [...names].sort();
}

export function validateBrandingConfig(branding) {
  assertRecord(branding, "branding config");
  if (!/^\d+\.\d+\.\d+$/.test(branding.version ?? "")) {
    throw new Error("branding version must use numeric major.minor.patch format");
  }
  if (branding.productName !== "ZtidalCode") {
    throw new Error("branding productName must be ZtidalCode");
  }
  const endpoints = branding.plugins?.updater?.endpoints;
  const endpoint = Array.isArray(endpoints) && endpoints.length === 1 ? endpoints[0] : null;
  const match =
    typeof endpoint === "string"
      ? endpoint.match(
          /^https:\/\/github\.com\/([A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+)\/releases\/latest\/download\/latest\.json$/,
        )
      : null;
  if (!match) {
    throw new Error(
      "cannot derive an exact GitHub repository from the branding updater endpoint",
    );
  }

  return {
    version: branding.version,
    productName: branding.productName,
    repo: match[1],
    tag: `v${branding.version}`,
  };
}

function readArtifactEntries(entries, readFile) {
  if (typeof readFile !== "function") throw new Error("readFile dependency is required");
  const bytesByName = {};
  const sha256ByName = {};

  for (const entry of entries) {
    let value;
    try {
      value = readFile(entry.path);
    } catch (error) {
      throw new Error(
        `cannot read local artifact ${entry.name}: ${error?.message ?? String(error)}`,
      );
    }
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      throw new Error(`local artifact ${entry.name} did not read as bytes`);
    }
    const bytes = Buffer.from(value);
    if (bytes.length === 0) throw new Error(`local artifact ${entry.name} is empty`);
    bytesByName[entry.name] = bytes;
    sha256ByName[entry.name] = createHash("sha256").update(bytes).digest("hex");
  }

  return { bytesByName, sha256ByName };
}

function verifyWindowsHandoffHashes(layout, handoff, sha256ByName) {
  const handoffHashes = new Map(handoff.files.map((file) => [file.name, file.sha256]));
  for (const entry of [layout.rawWindowsExe, ...layout.windows]) {
    if (sha256ByName[entry.name] !== handoffHashes.get(entry.name)?.toLowerCase()) {
      throw new Error(`SHA256 mismatch for ${entry.name}`);
    }
  }
}

export function verifyWindowsHandoffArtifacts({ layout, handoff, readFile }) {
  const result = readArtifactEntries(
    [layout.rawWindowsExe, ...layout.windows],
    readFile,
  );
  verifyWindowsHandoffHashes(layout, handoff, result.sha256ByName);
  return result;
}

export function verifyLocalArtifacts({ layout, handoff, readFile }) {
  const result = readArtifactEntries(
    [layout.rawWindowsExe, ...layout.windows, ...layout.mac],
    readFile,
  );

  verifyWindowsHandoffHashes(layout, handoff, result.sha256ByName);
  return result;
}

function exactObjectKeys(value, expectedKeys, errorMessage) {
  assertRecord(value, errorMessage);
  if (!sameStringSet(Object.keys(value), expectedKeys)) throw new Error(errorMessage);
}

export function validateGeneratedMetadata({
  manifest,
  checksumText,
  layout,
  repo,
  notes,
  bytesByName,
  sha256ByName,
}) {
  exactObjectKeys(
    manifest,
    ["version", "notes", "pub_date", "platforms"],
    "latest.json top-level keys are not exact",
  );
  const version = layout.tag.slice(1);
  if (manifest.version !== version) {
    throw new Error(`latest.json version does not match branding version ${version}`);
  }
  if (manifest.notes !== notes) {
    throw new Error("latest.json notes do not match --notes-file");
  }
  if (
    typeof manifest.pub_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(manifest.pub_date) ||
    Number.isNaN(Date.parse(manifest.pub_date)) ||
    new Date(manifest.pub_date).toISOString().replace(".000Z", "Z") !== manifest.pub_date
  ) {
    throw new Error("latest.json pub_date is not an exact RFC3339 UTC timestamp");
  }

  const platformExpectations = [
    ["windows-x86_64-nsis", layout.windows[0], layout.windows[1]],
    ["windows-x86_64", layout.windows[0], layout.windows[1]],
    ["windows-x86_64-msi", layout.windows[2], layout.windows[3]],
    ["darwin-aarch64-app", layout.mac[1], layout.mac[2]],
    ["darwin-aarch64", layout.mac[1], layout.mac[2]],
  ];
  const expectedPlatformKeys = platformExpectations.map(([key]) => key);
  assertRecord(manifest.platforms, "latest.json platforms must be an object");
  if (!sameStringSet(Object.keys(manifest.platforms), expectedPlatformKeys)) {
    throw new Error("latest.json platform keys do not match combined mode");
  }

  for (const [key, artifact, signatureFile] of platformExpectations) {
    const entry = manifest.platforms[key];
    exactObjectKeys(
      entry,
      ["signature", "url"],
      `latest.json entry for ${key} must contain only signature and url`,
    );
    const expectedUrl =
      `https://github.com/${repo}/releases/download/${layout.tag}/${artifact.name}`;
    if (entry.url !== expectedUrl) {
      throw new Error(`latest.json URL for ${key} is not the exact release asset URL`);
    }
    const signatureBytes = bytesByName[signatureFile.name];
    const expectedSignature = Buffer.from(signatureBytes).toString("utf8").trim();
    if (entry.signature !== expectedSignature) {
      throw new Error(`latest.json signature for ${key} does not match the local .sig`);
    }
  }

  if (typeof checksumText !== "string" || !checksumText.endsWith("\n")) {
    throw new Error("SHA256SUMS.txt must end with one newline");
  }
  const checksumLines = checksumText.slice(0, -1).split("\n");
  if (checksumLines.some((line) => line.length === 0)) {
    throw new Error("SHA256SUMS.txt contains a blank line");
  }
  const checksums = new Map();
  for (const line of checksumLines) {
    const match = line.match(/^([0-9a-f]{64}) \*(.+)$/);
    if (!match) throw new Error(`SHA256SUMS.txt has an invalid line: ${line}`);
    const [, hash, name] = match;
    if (checksums.has(name)) throw new Error(`SHA256SUMS.txt contains duplicate ${name}`);
    checksums.set(name, hash);
  }
  const releaseEntries = [layout.windows[0], layout.windows[2], ...layout.mac];
  const checksumNames = releaseEntries.map(({ name }) => name);
  if (!sameStringSet([...checksums.keys()], checksumNames)) {
    throw new Error("SHA256SUMS.txt names do not match the five release artifacts");
  }
  for (const { name } of releaseEntries) {
    if (checksums.get(name) !== sha256ByName[name]) {
      throw new Error(`SHA256SUMS.txt hash does not match ${name}`);
    }
  }

  return {
    platformKeys: [...expectedPlatformKeys].sort(),
    checksumNames: [...checksumNames].sort(),
  };
}

function sanitizedEnvironment(environment) {
  const env = { ...environment };
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  return env;
}

function defaultRunCommand(command, args, options = {}) {
  const env = sanitizedEnvironment(options.env ?? process.env);
  return spawnSync(command, args, { ...options, env });
}

function defaultRunSignedBuild(command, args, options = {}) {
  return spawnSync(command, args, options);
}

function defaultMakeTempDir() {
  return mkdtempSync(join(tmpdir(), "ztidal-release-finalize-"));
}

function defaultRemoveTempDir(path) {
  rmSync(path, { recursive: true, force: true });
}

function defaultWriteFile(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function commandFailureDetail(result) {
  if (result?.error) return result.error.message;
  const output = `${result?.stderr ?? ""}`.trim() || `${result?.stdout ?? ""}`.trim();
  return output;
}

function redactSecrets(value, secrets) {
  let redacted = `${value ?? ""}`;
  const orderedSecrets = [...new Set(secrets)]
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of orderedSecrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function runChecked(
  runCommand,
  command,
  args,
  { cwd, label, secrets = [], ...options },
) {
  let result;
  try {
    result = runCommand(command, args, {
      cwd,
      encoding: "utf8",
      ...options,
    });
  } catch (error) {
    throw new Error(
      `${label} could not start: ${redactSecrets(
        error?.message ?? String(error),
        secrets,
      )}`,
    );
  }
  if (!result || result.error || result.status !== 0) {
    const code = result?.status ?? "unknown";
    const detail = redactSecrets(commandFailureDetail(result), secrets);
    throw new Error(`${label} failed with exit code ${code}${detail ? `: ${detail}` : ""}`);
  }
  return typeof result.stdout === "string" ? result.stdout : "";
}

function readText(readFile, path, label) {
  let value;
  try {
    value = readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${label} ${path}: ${error?.message ?? String(error)}`);
  }
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  throw new Error(`${label} ${path} did not read as text`);
}

export function resolveSigningKey({
  environment = process.env,
  keyFile = null,
  readFile = readFileSync,
}) {
  const environmentKey = environment?.TAURI_SIGNING_PRIVATE_KEY;
  const password =
    typeof environment?.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === "string"
      ? environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
      : "";
  if (typeof environmentKey === "string" && environmentKey.length > 0) {
    return { privateKey: environmentKey, password };
  }

  const selectedKeyFile = keyFile || environment?.ZTIDAL_SIGNING_KEY_FILE;
  if (typeof selectedKeyFile !== "string" || selectedKeyFile.length === 0) {
    throw new Error(
      "no signing key: set TAURI_SIGNING_PRIVATE_KEY, pass --key <file>, or set ZTIDAL_SIGNING_KEY_FILE",
    );
  }
  const resolvedKeyFile = resolve(selectedKeyFile);
  const privateKey = readText(
    readFile,
    resolvedKeyFile,
    "signing key file",
  ).trim();
  if (privateKey.length === 0) {
    throw new Error(`signing key file ${resolvedKeyFile} is empty`);
  }
  return { privateKey, password };
}

function parseJson(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return value;
}

function releaseViewArgs(tag, repo) {
  return [
    "release",
    "view",
    tag,
    "--repo",
    repo,
    "--json",
    "isDraft,name,body,assets",
  ];
}

function readExactDraft({
  runCommand,
  repoRoot,
  repo,
  tag,
  expectedAssets,
  expectedRelease,
  phase,
}) {
  const output = runChecked(runCommand, "gh", releaseViewArgs(tag, repo), {
    cwd: repoRoot,
    label: `${phase} GitHub release lookup`,
  });
  const release = parseJson(output, `${phase} GitHub release response`);
  return validateDraftState(release, expectedAssets, phase, expectedRelease);
}

function expectedRemoteAssets(entries, sha256ByName, phase) {
  return entries.map(({ name }) => {
    const sha256 = sha256ByName[name];
    if (!/^[0-9a-f]{64}$/.test(sha256 ?? "")) {
      throw new Error(`${phase}: no verified local SHA256 for ${name}`);
    }
    return { name, sha256 };
  });
}

function assertGitState({ runCommand, repoRoot, expectedSha }) {
  const branch = runChecked(
    runCommand,
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: repoRoot, label: "git branch preflight" },
  ).trim();
  if (branch !== "hardening") {
    throw new Error(
      `releases must be finalized from hardening; current branch is ${branch || "unknown"}`,
    );
  }
  const dirt = runChecked(
    runCommand,
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    { cwd: repoRoot, label: "git cleanliness preflight" },
  );
  if (dirt.trim() !== "") {
    throw new Error(`working tree must be clean before draft finalization:\n${dirt.trimEnd()}`);
  }
  const head = runChecked(runCommand, "git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    label: "git HEAD preflight",
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(head) || head.toLowerCase() !== expectedSha) {
    throw new Error("HEAD does not match --expected-sha");
  }
}

export function finalizeReleaseDraft({
  repoRoot = defaultRepoRoot,
  expectedSha,
  windowsHandoff,
  notesFile,
  keyFile = null,
  environment = process.env,
  runCommand = defaultRunCommand,
  runSignedBuild = defaultRunSignedBuild,
  readFile = readFileSync,
  writeFile = defaultWriteFile,
  makeTempDir = defaultMakeTempDir,
  removeTempDir = defaultRemoveTempDir,
  nodeExecutable = process.execPath,
  log = console.log,
}) {
  if (!/^[0-9a-f]{40}$/i.test(expectedSha ?? "")) {
    throw new Error("--expected-sha must be exactly 40 hexadecimal characters");
  }
  if (typeof windowsHandoff !== "string" || windowsHandoff.length === 0) {
    throw new Error("--windows-handoff is required");
  }
  if (typeof notesFile !== "string" || notesFile.length === 0) {
    throw new Error("--notes-file is required");
  }
  for (const [name, dependency] of Object.entries({
    runCommand,
    runSignedBuild,
    readFile,
    writeFile,
    makeTempDir,
    removeTempDir,
  })) {
    if (typeof dependency !== "function") {
      throw new Error(`${name} dependency must be a function`);
    }
  }

  const root = resolve(repoRoot);
  const handoffPath = resolve(windowsHandoff);
  const resolvedNotesFile = resolve(notesFile);
  const normalizedExpectedSha = expectedSha.toLowerCase();
  const commandEnv = sanitizedEnvironment(environment ?? {});
  const runSanitizedCommand = (command, args, options = {}) =>
    runCommand(command, args, { ...options, env: commandEnv });

  assertGitState({
    runCommand: runSanitizedCommand,
    repoRoot: root,
    expectedSha: normalizedExpectedSha,
  });

  const branding = validateBrandingConfig(
    parseJson(
      readText(
        readFile,
        join(root, "branding", "ztidalcode.json"),
        "branding config",
      ),
      "branding config",
    ),
  );
  const notes = readText(readFile, resolvedNotesFile, "notes file").trim();
  if (notes.length === 0) throw new Error("--notes-file must contain non-empty release notes");
  const sourceLayout = createReleaseLayout({
    repoRoot: root,
    productName: branding.productName,
    version: branding.version,
  });
  if (sourceLayout.tag !== branding.tag) {
    throw new Error("derived release tag is inconsistent");
  }
  const handoff = validateWindowsHandoff(
    parseJson(
      readText(readFile, handoffPath, "Windows handoff"),
      "Windows handoff",
    ),
    {
      version: branding.version,
      expectedSha: normalizedExpectedSha,
      expectedNames: sourceLayout.handoffNames,
    },
  );
  const signing = resolveSigningKey({ environment, keyFile, readFile });
  const initialWindows = verifyWindowsHandoffArtifacts({
    layout: sourceLayout,
    handoff,
    readFile,
  });
  const initialWindowsAssets = expectedRemoteAssets(
    sourceLayout.windows,
    initialWindows.sha256ByName,
    "before finalization",
  );

  log(`verified local Windows handoff for ${branding.tag}`);
  readExactDraft({
    runCommand: runSanitizedCommand,
    repoRoot: root,
    repo: branding.repo,
    tag: branding.tag,
    expectedAssets: initialWindowsAssets,
    phase: "before finalization",
  });

  let freshTargetDir = null;
  try {
    freshTargetDir = resolve(makeTempDir());
    const layout = createReleaseLayout({
      repoRoot: root,
      productName: branding.productName,
      version: branding.version,
      releaseRoot: join(
        freshTargetDir,
        "aarch64-apple-darwin",
        "release",
      ),
      metadataRoot: freshTargetDir,
    });
    const buildEnv = {
      ...commandEnv,
      CARGO_TARGET_DIR: freshTargetDir,
      TAURI_SIGNING_PRIVATE_KEY: signing.privateKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signing.password,
    };
    runChecked(
      runSignedBuild,
      "npm",
      [
        "run",
        "tauri",
        "--",
        "build",
        "--config",
        "branding/ztidalcode.json",
        "--target",
        "aarch64-apple-darwin",
      ],
      {
        cwd: root,
        label: "fresh arm64 Mac build",
        env: buildEnv,
        secrets: [signing.privateKey, signing.password],
      },
    );

    assertGitState({
      runCommand: runSanitizedCommand,
      repoRoot: root,
      expectedSha: normalizedExpectedSha,
    });
    readArtifactEntries(layout.mac, readFile);

    const sourceWindowsEntries = [
      sourceLayout.rawWindowsExe,
      ...sourceLayout.windows,
    ];
    const stagedWindowsEntries = [layout.rawWindowsExe, ...layout.windows];
    for (let index = 0; index < sourceWindowsEntries.length; index += 1) {
      const sourceEntry = sourceWindowsEntries[index];
      const stagedEntry = stagedWindowsEntries[index];
      if (sourceEntry.name !== stagedEntry.name) {
        throw new Error("Windows staging layout names are inconsistent");
      }
      writeFile(
        stagedEntry.path,
        Buffer.from(initialWindows.bytesByName[sourceEntry.name]),
      );
    }

    verifyLocalArtifacts({ layout, handoff, readFile });
    runChecked(
      runSanitizedCommand,
      nodeExecutable,
      [
        join(root, "scripts", "make-updater-json.mjs"),
        "--mode",
        "combined",
        "--notes",
        notes,
        "--tag",
        branding.tag,
        "--bundle-dir",
        layout.bundleDir,
        "--exe",
        layout.rawWindowsExe.path,
        "--out",
        layout.metadata[0].path,
      ],
      { cwd: root, label: "make-updater-json" },
    );

    const notesAfterGeneration = readText(
      readFile,
      resolvedNotesFile,
      "notes file",
    ).trim();
    if (notesAfterGeneration !== notes) {
      throw new Error("--notes-file changed during finalization");
    }
    verifyWindowsHandoffArtifacts({
      layout: sourceLayout,
      handoff,
      readFile,
    });
    const localArtifacts = verifyLocalArtifacts({ layout, handoff, readFile });

    const manifestText = readText(
      readFile,
      layout.metadata[0].path,
      "generated latest.json",
    );
    const manifest = parseJson(manifestText, "generated latest.json");
    const checksumText = readText(
      readFile,
      layout.metadata[1].path,
      "generated SHA256SUMS.txt",
    );
    validateGeneratedMetadata({
      manifest,
      checksumText,
      layout,
      repo: branding.repo,
      notes,
      ...localArtifacts,
    });

    assertGitState({
      runCommand: runSanitizedCommand,
      repoRoot: root,
      expectedSha: normalizedExpectedSha,
    });

    const windowsAssets = expectedRemoteAssets(
      sourceLayout.windows,
      localArtifacts.sha256ByName,
      "immediately before upload",
    );
    readExactDraft({
      runCommand: runSanitizedCommand,
      repoRoot: root,
      repo: branding.repo,
      tag: branding.tag,
      expectedAssets: windowsAssets,
      phase: "immediately before upload",
    });
    const notesBeforeUpload = readText(
      readFile,
      resolvedNotesFile,
      "notes file",
    ).trim();
    if (notesBeforeUpload !== notes) {
      throw new Error("--notes-file changed during finalization");
    }

    verifyWindowsHandoffArtifacts({
      layout: sourceLayout,
      handoff,
      readFile,
    });
    const uploadArtifacts = verifyLocalArtifacts({ layout, handoff, readFile });
    const manifestBeforeUpload = readText(
      readFile,
      layout.metadata[0].path,
      "generated latest.json",
    );
    const checksumBeforeUpload = readText(
      readFile,
      layout.metadata[1].path,
      "generated SHA256SUMS.txt",
    );
    if (
      manifestBeforeUpload !== manifestText ||
      checksumBeforeUpload !== checksumText
    ) {
      throw new Error("generated release metadata changed before upload");
    }

    const uploadedEntries = [...layout.mac, ...layout.metadata];
    runChecked(
      runSanitizedCommand,
      "gh",
      [
        "release",
        "upload",
        branding.tag,
        ...uploadedEntries.map(({ path }) => path),
        "--repo",
        branding.repo,
      ],
      { cwd: root, label: "GitHub draft asset upload" },
    );
    runChecked(
      runSanitizedCommand,
      "gh",
      [
        "release",
        "edit",
        branding.tag,
        "--repo",
        branding.repo,
        "--title",
        `${branding.productName} ${branding.version}`,
        "--notes",
        notes,
      ],
      { cwd: root, label: "GitHub draft title and notes update" },
    );

    const finalSha256ByName = {
      ...uploadArtifacts.sha256ByName,
      [layout.metadata[0].name]: createHash("sha256")
        .update(manifestBeforeUpload, "utf8")
        .digest("hex"),
      [layout.metadata[1].name]: createHash("sha256")
        .update(checksumBeforeUpload, "utf8")
        .digest("hex"),
    };
    const finalAssets = expectedRemoteAssets(
      [...layout.windows, ...layout.mac, ...layout.metadata],
      finalSha256ByName,
      "after finalization",
    );
    const assetNames = readExactDraft({
      runCommand: runSanitizedCommand,
      repoRoot: root,
      repo: branding.repo,
      tag: branding.tag,
      expectedAssets: finalAssets,
      expectedRelease: {
        name: `${branding.productName} ${branding.version}`,
        body: notes,
      },
      phase: "after finalization",
    });
    log(`finalized ${branding.tag} with 9 assets; release remains a draft`);

    return {
      version: branding.version,
      tag: branding.tag,
      repo: branding.repo,
      uploaded: uploadedEntries.map(({ name }) => name),
      assetNames,
      isDraft: true,
    };
  } finally {
    if (freshTargetDir !== null) removeTempDir(freshTargetDir);
  }
}

export const usage = `usage: node scripts/finalize-release-draft.mjs \\
  --expected-sha <40-hex-commit> \\
  --windows-handoff <windows-handoff.json> \\
  --notes-file <NOTES.md> \\
  [--key <minisign-private-key-file>]

Fail-closed Mac-side finalization for an existing Windows-only GitHub draft.
It builds Apple Silicon from the exact clean commit in a fresh CARGO_TARGET_DIR,
verifies handoff hashes, combined updater metadata, and exact draft assets; uploads
five final files and keeps the release in draft state. It never publishes and never
uses --clobber. The signing key comes from TAURI_SIGNING_PRIVATE_KEY, --key, or
ZTIDAL_SIGNING_KEY_FILE and is exposed only to the native build child.`;

export function main(argv = process.argv.slice(2)) {
  const parsed = parseFinalizeArgs(argv);
  if (parsed.help) {
    console.log(usage);
    return null;
  }
  return finalizeReleaseDraft({
    repoRoot: defaultRepoRoot,
    expectedSha: parsed.expectedSha,
    windowsHandoff: parsed.windowsHandoff,
    notesFile: parsed.notesFile,
    keyFile: parsed.keyFile,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(`finalize-release-draft: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  }
}
