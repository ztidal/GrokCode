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
 * Usage:
 *   node scripts/make-updater-json.mjs --notes "what changed in this release"
 *   node scripts/make-updater-json.mjs --notes-file NOTES.md --tag v0.0.8 --out latest.json
 *
 * Options:
 *   --notes <text>      release notes; shown in the UpdateModal  (required unless --notes-file)
 *   --notes-file <path> read the notes from a file instead
 *   --tag <tag>         release tag the assets live under        (default `v<version>`)
 *   --bundle-dir <dir>  where the bundles are                    (default src-tauri/target/release/bundle)
 *   --out <path>        output file                              (default latest.json)
 *   --pub-date <iso>    publication date                         (default now)
 */
import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// --- collect the bundles ----------------------------------------------------------------------

const bundleDir = arg("bundle-dir", join(repoRoot, "src-tauri", "target", "release", "bundle"));

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
for (const { keys, subdir, ext } of installers) {
  const path = findBundle(subdir, ext);
  if (!path) die(`no ${ext} bundle under ${join(bundleDir, subdir)} — build with the branding overlay first`);

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
  for (const key of keys) {
    platforms[key] = { signature, url: `${downloadBase}/${basename(path)}` };
  }
}

// --- emit -------------------------------------------------------------------------------------

const pubDate = arg("pub-date", new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
const out = arg("out", join(process.cwd(), "latest.json"));
writeFileSync(out, `${JSON.stringify({ version, notes, pub_date: pubDate, platforms }, null, 2)}\n`);

console.log(`\nwrote ${out}`);
console.log(`  version   ${version}   tag ${tag}`);
for (const [key, meta] of Object.entries(platforms)) {
  console.log(`  ${key.padEnd(21)} ${basename(meta.url)}`);
}
