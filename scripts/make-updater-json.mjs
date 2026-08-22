/**
 * Build the update feed (`latest.json`) from the bundles in `src-tauri/target/release/bundle`.
 *
 * One platform key per installer kind. The updater looks up `{os}-{arch}-{installer}` first and
 * only then falls back to `{os}-{arch}`, and the installer kind is not guessed at runtime — the
 * bundler stamps it into each binary (`__TAURI_BUNDLE_TYPE_VAR_MSI` / `..._NSS`), so an
 * MSI-installed client and an NSIS-installed one ask for different keys. A feed carrying only the
 * generic key hands the MSI client the NSIS installer: it installs cleanly, but it relocates the
 * app from `%LOCALAPPDATA%\Programs\ZtidalCode` to `%LOCALAPPDATA%\ZtidalCode`, which orphans
 * whatever the user pinned to their taskbar.
 *
 * Every signature is verified against the bundle bytes before being written, so the feed cannot
 * ship a signature from a different build than the artifact it points at — the one failure that
 * looks perfectly healthy from the outside and breaks every client at install time.
 *
 * That check cannot tell a build made through `branding/ztidalcode.json` from one made without it:
 * the signing key comes from the environment, so both are correctly signed. Only the compiled-in
 * updater identity differs, and a build without the overlay carries upstream's trust anchor and
 * upstream's feed — it installs, runs and looks healthy, and then every client that installs it
 * walks itself onto upstream's next release. So the binary is checked for our pubkey first.
 *
 * Usage:
 *   node scripts/make-updater-json.mjs --notes "what changed in this release"
 *   node scripts/make-updater-json.mjs --notes-file NOTES.md --tag v0.0.8 --out latest.json
 *
 * Options:
 *   --notes <text>      release notes; shown in the UpdateModal  (required unless --notes-file)
 *   --notes-file <path> read the notes from a file instead
 *   --tag <tag>         release tag the assets live under        (default `v<version>`)
 *   --bundle-dir <dir>  where the bundles are                    (default src-tauri/target/release/bundle)
 *   --exe <path>        the built binary the provenance check reads  (default <bundle-dir>/../<name>.exe)
 *   --out <path>        output file                              (default latest.json)
 *   --pub-date <iso>    publication date                         (default now)
 */
import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
}

function die(message) {
  console.error(`make-updater-json: ${message}`);
  process.exit(1);
}

// --- identity: version, trust anchor and feed all come from the branding overlay ------------

const branding = JSON.parse(
  readFileSync(join(repoRoot, "branding", "ztidalcode.json"), "utf8"),
);
const version = branding.version;
const pubkeyB64 = branding.plugins?.updater?.pubkey;
const endpoint = branding.plugins?.updater?.endpoints?.[0];
if (!version || !pubkeyB64 || !endpoint) {
  die("branding/ztidalcode.json is missing version, updater.pubkey or updater.endpoints[0]");
}

// https://github.com/<owner>/<repo>/releases/latest/download/latest.json
const repoMatch = endpoint.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\//);
if (!repoMatch) die(`cannot derive the repository from the updater endpoint: ${endpoint}`);
const tag = arg("tag", `v${version}`);
const downloadBase = `https://github.com/${repoMatch[1]}/releases/download/${tag}`;

const notesFile = arg("notes-file");
const notes = (notesFile ? readFileSync(notesFile, "utf8") : arg("notes", "")).trim();
// Fail closed: an empty changelog means the UpdateModal shows a version bump and nothing else.
if (!notes) die("--notes or --notes-file is required");

// --- minisign verification, matching tauri-plugin-updater's `verify_signature` ---------------

/** Decode a minisign key/signature line into `{ algorithm, keyId, bytes }`. */
function decodeLine(line) {
  const raw = Buffer.from(line.trim(), "base64");
  return {
    algorithm: raw.subarray(0, 2).toString("latin1"),
    keyId: raw.subarray(2, 10),
    bytes: raw.subarray(10),
  };
}

const pubText = Buffer.from(pubkeyB64, "base64").toString("utf8");
const pub = decodeLine(pubText.trim().split("\n")[1]);
const publicKey = createPublicKey({
  // SPKI prefix for Ed25519, so node can take the 32 raw key bytes.
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.bytes.subarray(0, 32)]),
  format: "der",
  type: "spki",
});

/**
 * Verify `signatureB64` (a base64-wrapped minisign `.sig`) against `bytes`.
 * Returns the trusted comment; throws with the reason if anything does not line up.
 */
function verifyBundle(bytes, signatureB64, expectedName) {
  const lines = Buffer.from(signatureB64, "base64").toString("utf8").split("\n");
  const sig = decodeLine(lines[1]);
  const trustedComment = lines[2].replace(/^trusted comment: /, "");
  const globalSig = Buffer.from(lines[3].trim(), "base64");

  if (!pub.keyId.equals(sig.keyId)) {
    throw new Error(
      `signed by key ${sig.keyId.toString("hex").toUpperCase()}, but the feed trusts ` +
        `${pub.keyId.toString("hex").toUpperCase()}`,
    );
  }
  // `ED` prehashes the file with BLAKE2b-512; `Ed` signs the bytes directly.
  const message = sig.algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes;
  if (!verifyEd25519(null, message, publicKey, sig.bytes.subarray(0, 64))) {
    throw new Error("signature does not match the bundle bytes");
  }
  if (!verifyEd25519(null, Buffer.concat([sig.bytes.subarray(0, 64), Buffer.from(trustedComment, "utf8")]), publicKey, globalSig)) {
    throw new Error("trusted comment is not signed by the same key");
  }
  // The signer records the file it signed; a mismatch means a stale `.sig` was picked up.
  const signedName = trustedComment.match(/file:(.+)$/)?.[1]?.trim();
  if (signedName && signedName !== expectedName) {
    throw new Error(`signature is for ${signedName}, not ${expectedName}`);
  }
  return trustedComment;
}

function tarString(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

/** Read exact, short ustar paths without extracting anything to disk. */
function readTarFiles(gzipBytes, expectedNames) {
  let tar;
  try {
    tar = gunzipSync(gzipBytes);
  } catch (error) {
    throw new Error(`cannot decompress gzip archive: ${error.message}`);
  }

  const expected = new Set(expectedNames);
  const found = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeField = tarString(header, 124, 12).trim();
    const size = sizeField === "" ? 0 : Number.parseInt(sizeField, 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`invalid tar size for ${path || "unnamed entry"}`);
    }

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new Error(`truncated tar entry ${path || "unnamed entry"}`);
    }
    if (expected.has(path)) {
      found.set(path, Buffer.from(tar.subarray(dataStart, dataEnd)));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  for (const name of expected) {
    if (!found.has(name)) throw new Error(`archive is missing ${name}`);
  }
  return found;
}

// --- provenance: the bundles must wrap a binary built through the overlay ---------------------

const bundleDir = arg("bundle-dir", join(repoRoot, "src-tauri", "target", "release", "bundle"));

const baseConf = JSON.parse(readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"));
// Tauri names the executable after `mainBinaryName` and only falls back to `productName`; the
// overlay is merged over the base config, so either file can be the one that supplies either key.
const binaryName =
  branding.mainBinaryName ?? baseConf.mainBinaryName ?? branding.productName ?? baseConf.productName;
if (!binaryName) die("neither branding/ztidalcode.json nor src-tauri/tauri.conf.json names the binary");

// Both installers wrap this one file, and both compress it, so the binary itself is the only
// place the pubkey string is findable. It sits beside the bundle directory the build produced.
const binary = arg("exe", join(bundleDir, "..", `${binaryName}.exe`));
// Read out of the base config rather than pinned here, so this still names the right key after an
// upstream sync rotates it.
const upstreamPubkey = baseConf.plugins?.updater?.pubkey;

function verifyBrandedBytes(bytes, name) {
  const carries = (key) => bytes.includes(Buffer.from(key, "utf8"));
  if (!carries(pubkeyB64)) {
    die(
      `${name} does not carry our updater key — it was built without ` +
        "--config branding/ztidalcode.json; rebuild and re-bundle before publishing",
    );
  }
  if (upstreamPubkey && upstreamPubkey !== pubkeyB64 && carries(upstreamPubkey)) {
    die(
      `${name} also carries the updater key from src-tauri/tauri.conf.json — the overlay ` +
        "did not replace the trust anchor; do not publish this build",
    );
  }
  console.log(`${name}  ${bytes.length} bytes  built through the branding overlay`);
}

function verifyBrandedBinary(path) {
  verifyBrandedBytes(readFileSync(path), basename(path));
}

// --- collect the bundles ----------------------------------------------------------------------

/** Newest bundle in `<bundleDir>/<subdir>` whose name ends with `ext` (ignoring `.sig` files). */
function findBundle(subdir, ext) {
  const dir = join(bundleDir, subdir);
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir).filter((n) => n.endsWith(ext) && !n.endsWith(".sig"));
  if (hits.length === 0) return null;
  if (hits.length > 1) {
    die(`${dir} holds more than one ${ext}: ${hits.join(", ")} — clean it before publishing`);
  }
  return join(dir, hits[0]);
}

// `windows-x86_64` is the fallback the updater reaches for when it cannot tell how the client was
// installed; NSIS is the installer we hand to everyone else, so it is the safe default there.
const installers = [
  { keys: ["windows-x86_64-nsis", "windows-x86_64"], subdir: "nsis", ext: "-setup.exe" },
  { keys: ["windows-x86_64-msi"], subdir: "msi", ext: ".msi" },
];

const platforms = {};
const checksums = [];
const windowsBundles = installers.map((installer) => ({
  ...installer,
  path: findBundle(installer.subdir, installer.ext),
}));
const hasAnyWindowsArtifact =
  existsSync(binary) || windowsBundles.some(({ path }) => path !== null);

if (hasAnyWindowsArtifact) {
  if (!existsSync(binary)) {
    die(`${binary} is missing — build it: npm run tauri -- build --config branding/ztidalcode.json`);
  }
  verifyBrandedBinary(binary);
}

for (const { keys, subdir, ext, path } of hasAnyWindowsArtifact ? windowsBundles : []) {
  if (!path) {
    die(
      `no ${ext} bundle under ${join(bundleDir, subdir)} — build with the branding overlay first`,
    );
  }

  const sigPath = `${path}.sig`;
  if (!existsSync(sigPath)) {
    die(`${basename(path)} has no .sig — the build ran without TAURI_SIGNING_PRIVATE_KEY`);
  }
  const signature = readFileSync(sigPath, "utf8").trim();
  const bytes = readFileSync(path);
  let trustedComment;
  try {
    trustedComment = verifyBundle(bytes, signature, basename(path));
  } catch (error) {
    die(`${basename(path)}: ${error.message}`);
  }

  console.log(`${basename(path)}  ${bytes.length} bytes  verified  (${trustedComment})`);
  // The landing page tells people to check their download against this file,
  // so it has to exist on every release. It was written by hand until a
  // release went out without one, which is the only way that ever ends.
  // Names are flat because release assets are flat: sha256sum -c has to
  // work in the folder the download landed in.
  checksums.push(
    `${createHash("sha256").update(bytes).digest("hex")} *${basename(path)}`,
  );
  for (const key of keys) {
    platforms[key] = { signature, url: `${downloadBase}/${basename(path)}` };
  }
}

// Tauri's macOS updater installs the signed `.app.tar.gz`; the DMG is the human-facing installer
// and therefore belongs in SHA256SUMS, but never in a platform entry. The archive name itself does
// not carry an architecture, so the companion DMG is deliberately exact and arm64-specific rather
// than accepting any `.dmg` left behind by another target or version.
const productName = branding.productName;
const macArchiveName = `${productName}.app.tar.gz`;
const macArchive = join(bundleDir, "macos", macArchiveName);
const macSignaturePath = `${macArchive}.sig`;
const macDmgName = `${productName}_${version}_aarch64.dmg`;
const macDmg = join(bundleDir, "dmg", macDmgName);
const hasAnyMacArtifact =
  existsSync(macArchive) ||
  existsSync(macSignaturePath) ||
  existsSync(macDmg);

if (hasAnyMacArtifact) {
  if (!existsSync(macArchive)) {
    die(`${macArchive} is missing — build the arm64 macOS bundle with the branding overlay first`);
  }
  if (!existsSync(macSignaturePath)) {
    die(`${macArchiveName} has no .sig — the build ran without TAURI_SIGNING_PRIVATE_KEY`);
  }
  if (!existsSync(macDmg)) {
    die(`${macDmg} is missing — expected the arm64 DMG for version ${version}`);
  }

  const archiveBytes = readFileSync(macArchive);
  const signatureFileBytes = readFileSync(macSignaturePath);
  const signature = signatureFileBytes.toString("utf8").trim();
  let trustedComment;
  try {
    trustedComment = verifyBundle(archiveBytes, signature, macArchiveName);
  } catch (error) {
    die(`${macArchiveName}: ${error.message}`);
  }

  const archivedInfoPath = `${productName}.app/Contents/Info.plist`;
  const archivedBinaryPath = `${productName}.app/Contents/MacOS/${binaryName}`;
  let archivedFiles;
  try {
    archivedFiles = readTarFiles(archiveBytes, [archivedInfoPath, archivedBinaryPath]);
  } catch (error) {
    die(`${macArchiveName}: ${error.message}`);
  }
  const archivedInfo = archivedFiles.get(archivedInfoPath).toString("utf8");
  const appVersion = archivedInfo.match(
    /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/,
  )?.[1];
  if (!appVersion) {
    die(`${macArchiveName}: ${archivedInfoPath} has no CFBundleShortVersionString`);
  }
  if (appVersion !== version) {
    die(`Mac app version is ${appVersion}, but branding version is ${version}`);
  }
  const archivedBinary = archivedFiles.get(archivedBinaryPath);
  const isThinArm64MachO =
    archivedBinary.length >= 8 &&
    archivedBinary.readUInt32LE(0) === 0xfeedfacf &&
    archivedBinary.readUInt32LE(4) === 0x0100000c;
  if (!isThinArm64MachO) {
    die(`${binaryName} is not a thin arm64 Mach-O executable`);
  }
  verifyBrandedBytes(archivedBinary, binaryName);

  console.log(
    `${macArchiveName}  ${archiveBytes.length} bytes  verified  (${trustedComment})`,
  );
  for (const key of ["darwin-aarch64-app", "darwin-aarch64"]) {
    platforms[key] = { signature, url: `${downloadBase}/${macArchiveName}` };
  }

  for (const [name, bytes] of [
    [macDmgName, readFileSync(macDmg)],
    [macArchiveName, archiveBytes],
    [`${macArchiveName}.sig`, signatureFileBytes],
  ]) {
    checksums.push(`${createHash("sha256").update(bytes).digest("hex")} *${name}`);
  }
}

if (Object.keys(platforms).length === 0) {
  die(`no Windows or arm64 macOS updater bundles found under ${bundleDir}`);
}

// --- emit -------------------------------------------------------------------------------------

const pubDate = arg("pub-date", new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
const out = arg("out", join(process.cwd(), "latest.json"));
writeFileSync(out, `${JSON.stringify({ version, notes, pub_date: pubDate, platforms }, null, 2)}\n`);

const sumsPath = join(dirname(out), "SHA256SUMS.txt");
writeFileSync(sumsPath, `${checksums.join(String.fromCharCode(10))}${String.fromCharCode(10)}`);

console.log(`\nwrote ${out}`);
console.log(`wrote ${sumsPath}`);
console.log(`  version   ${version}   tag ${tag}`);
for (const [key, meta] of Object.entries(platforms)) {
  console.log(`  ${key.padEnd(21)} ${basename(meta.url)}`);
}
