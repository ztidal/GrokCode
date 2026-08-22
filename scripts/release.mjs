/**
 * Cut a release end to end — the seven hand-typed steps of branding/README.md, each with the check
 * whose absence has already shipped a mistake once: a build made from another session's
 * half-finished tree, a release missing its SHA256SUMS.txt, a latest.json committed to the source
 * repository.
 *
 * Usage:
 *   npm run release -- --notes "what changed"           # build + verified feed, then stop
 *   npm run release -- --no-commit --notes-file C:\release\NOTES.md --draft
 *                                                        # Windows handoff; never publishes
 *   npm run release -- --dry-run --notes "what changed" # preflight + plan, no writes at all
 *
 * `--help` lists every flag. If the build fails after the version commit, rerun with --no-commit —
 * the bump is already committed and nothing else needs undoing.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertWindowsReleaseTagAbsent,
  assertRemoteGitTagAbsent,
  buildWindowsHandoff,
  readRemoteGitTag,
  readReleaseTag,
  sanitizedReleaseEnvironment,
} from "./release-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// A sibling of this checkout (D:/…/ztidal-release-wt in the canonical layout), outside the repo so
// nothing the build does can dirty the tree being released.
const worktree = resolve(repoRoot, "..", "ztidal-release-wt");
// The worktree build compiles into the main checkout's target dir to reuse the cargo cache — which
// is why every artifact path below lives under the main repo, not under the worktree.
const targetDir = join(repoRoot, "src-tauri", "target");
const bundleDir = join(targetDir, "release", "bundle");
const distRepo = "ztidal/ZtidalCode-dist";
const brandingPath = join(repoRoot, "branding", "ztidalcode.json");

function die(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  // A flag is never a value: "--notes --draft" must refuse, not stage a
  // release whose changelog is the string "--draft".
  if (value === undefined || value.startsWith("--")) {
    die(`--${name} needs a value, got ${value ?? "nothing"}`);
  }
  return value;
}

function has(name) {
  return process.argv.includes(`--${name}`);
}

// No child inherits the signing key by accident: the build gets it explicitly,
// and gh / powershell / the feed script have no business seeing it at all.
const cleanEnv = sanitizedReleaseEnvironment(process.env);

function run(cmd, args, opts = {}) {
  console.log(`\n==> ${cmd} ${args.join(" ")}\n`);
  const r = spawnSync(cmd, args, { stdio: "inherit", env: cleanEnv, ...opts });
  if (r.error) die(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} exited with ${r.status}`);
}

function git(args, opts = {}) {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", env: cleanEnv, ...opts });
  if (r.error) die(`git ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) die(`git ${args.join(" ")}: ${(r.stderr || r.stdout || "").trim()}`);
  return r.stdout.trim();
}

const usage = `usage: npm run release -- [options]

Cuts a ZtidalCode release from the hardening branch: bumps branding/ztidalcode.json (one commit,
"build: X.Y.Z" — the only git write this script makes), builds in a detached release worktree so
the bundles can only contain what is committed, generates and verifies the update feed
(latest.json + SHA256SUMS.txt in the repo root), and on request installs or stages its Windows
artifacts in a GitHub draft. The Mac-side release owner completes and publishes that draft.

options
  --notes <text>       release notes (this or --notes-file is required); they become
                       latest.json's changelog and the GitHub release body
  --notes-file <path>  read the notes from a file instead
  --version <X.Y.Z>    release this version                (default: current patch + 1)
  --no-commit          skip the bump; build the version HEAD already carries
  --key <path>         minisign private key file (see key sources below)
  --install            after verifying: run the NSIS setup with /P /R and confirm the
                       installed exe reports the new version
  --draft              after verifying: create draft v<X.Y.Z> on ${distRepo};
                       only the two Windows installers and signatures are staged; never publish. Refuses
                       an existing tag instead of mutating already-staged release bytes
  --dry-run            preflight and plan only — writes nothing, commits nothing
  --help               this text

With neither --install nor --draft the run stops after the verified artifacts and prints
exactly what those flags would do.

Every successful build writes src-tauri/target/release/windows-handoff.json for the Mac-side
release owner. That provenance JSON and the raw PinkCode.exe are local handoff files, never uploaded.

signing key — first source that answers wins; the contents are read in-process and exported only
into the build child's environment, never onto a command line, into a file, or into output:
  1. TAURI_SIGNING_PRIVATE_KEY   already set in the environment (used as-is)
  2. --key <file>
  3. ZTIDAL_SIGNING_KEY_FILE     environment variable naming the file

failure recovery: if the build fails after the version commit, rerun with --no-commit — the bump
is already committed; nothing else needs undoing.`;

if (has("help")) {
  console.log(usage);
  process.exit(0);
}

// A typo like --dryrun must not fall through to a real release.
const valueFlags = ["notes", "notes-file", "version", "key"];
const booleanFlags = ["no-commit", "install", "draft", "dry-run", "help"];
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (!token.startsWith("--")) die(`unexpected argument ${token} (see --help)`);
  const name = token.slice(2);
  if (valueFlags.includes(name)) {
    if (i + 1 >= process.argv.length) die(`--${name} needs a value`);
    i++;
    continue;
  }
  if (!booleanFlags.includes(name)) die(`unknown flag ${token} (see --help)`);
}

const dryRun = has("dry-run");
const noCommit = has("no-commit");
const doInstall = has("install");
const doDraft = has("draft");

if (doDraft && !noCommit) {
  die("--draft requires --no-commit so Windows stages the Mac owner's committed release SHA");
}

// --- preflight: every refusal here is a release incident that already happened once -----------

const lower = (p) => resolve(p).toLowerCase();
// The worktree carries a copy of this script; run from there, the version commit would land on
// the throwaway detached HEAD.
if (lower(repoRoot) === lower(worktree) || `${lower(process.cwd())}${sep}`.startsWith(`${lower(worktree)}${sep}`)) {
  die(`this is the release worktree — run from the main checkout`);
}

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "hardening") die(`on branch ${branch}; releases are cut from hardening only`);

const dirt = git(["status", "--porcelain"]);
if (dirt !== "") die(`the working tree is dirty — a release must build exactly what is committed:\n${dirt}`);

const notesFile = arg("notes-file") ? resolve(arg("notes-file")) : null;
const notesText = arg("notes");
// Checked before the build, not after — make-updater-json would only refuse once the build
// minutes are already spent.
if (!notesFile && !notesText) die("--notes or --notes-file is required; the feed refuses an empty changelog");
if (notesFile && notesText) die("--notes and --notes-file are mutually exclusive");
if (notesFile && !existsSync(notesFile)) die(`--notes-file: ${notesFile} does not exist`);

let keyFile = null;
let keyLabel;
if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
  keyLabel = "TAURI_SIGNING_PRIVATE_KEY already set in the environment";
} else {
  keyFile = arg("key") ?? process.env.ZTIDAL_SIGNING_KEY_FILE ?? null;
  if (!keyFile) die("no signing key: set TAURI_SIGNING_PRIVATE_KEY, pass --key <file>, or set ZTIDAL_SIGNING_KEY_FILE");
  keyFile = resolve(keyFile);
  if (!existsSync(keyFile)) die(`signing key file ${keyFile} does not exist`);
  keyLabel = `contents of ${keyFile}, read at build time`;
}

if (
  doDraft &&
  spawnSync("gh", ["--version"], { stdio: "ignore", env: cleanEnv }).status !== 0
) {
  die("--draft needs the gh CLI on PATH");
}
if (doInstall && !process.env.LOCALAPPDATA) die("--install needs LOCALAPPDATA to find the installed exe");

// --- version ----------------------------------------------------------------------------------

const brandingText = readFileSync(brandingPath, "utf8");
const branding = JSON.parse(brandingText);
const currentVersion = branding.version;
const productName = branding.productName;
if (!/^\d+\.\d+\.\d+$/.test(currentVersion ?? "")) {
  die(`branding/ztidalcode.json carries version "${currentVersion}"; expected X.Y.Z`);
}
if (!productName) die("branding/ztidalcode.json names no productName");
// Tauri names the exe after mainBinaryName and only falls back to productName; the overlay is
// merged over the base config, so either file can supply either key.
const baseConf = JSON.parse(readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"));
const binaryName =
  branding.mainBinaryName ?? baseConf.mainBinaryName ?? branding.productName ?? baseConf.productName;

let version;
if (noCommit) {
  version = currentVersion;
  if (arg("version") && arg("version") !== version) {
    die(`--no-commit rebuilds the committed version (${version}); it cannot also take --version ${arg("version")}`);
  }
} else {
  const [x, y, z] = currentVersion.split(".").map(Number);
  version = arg("version") ?? `${x}.${y}.${z + 1}`;
  if (!/^\d+\.\d+\.\d+$/.test(version)) die(`--version ${version} is not X.Y.Z`);
  // Windows Installer caps the major at 255, and Tauri only rejects that at bundle time — after
  // the whole compile (branding/README.md, "Versioning").
  const [vMajor, vMinor, vPatch] = version.split(".").map(Number);
  if (vMajor > 255 || vMinor > 255) die(`version ${version}: MSI caps major and minor at 255`);
  if (vPatch > 65535) die(`version ${version}: MSI caps the patch number at 65535`);
  if (version === currentVersion) {
    die(`${version} is already the committed version; rerun with --no-commit to rebuild it`);
  }
}

// --- plan -------------------------------------------------------------------------------------

// Two versions side by side make make-updater-json refuse — it cannot know which one the feed
// should describe — and that refusal has fired in practice.
function staleBundles() {
  const stale = [];
  for (const sub of ["nsis", "msi"]) {
    const dir = join(bundleDir, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`${productName}_`) && !name.includes(`_${version}_`)) stale.push(join(dir, name));
    }
  }
  return stale;
}

const feedArgs = [
  join(repoRoot, "scripts", "make-updater-json.mjs"),
  "--bundle-dir",
  bundleDir,
  "--out",
  join(repoRoot, "latest.json"),
  "--mode",
  "windows",
  ...(notesFile ? ["--notes-file", notesFile] : ["--notes", notesText]),
];

const installedExe = join(process.env.LOCALAPPDATA ?? "%LOCALAPPDATA%", productName, `${binaryName}.exe`);
const stale = staleBundles();

console.log(
  noCommit
    ? `release ${version} (rebuilding the bump HEAD already carries)`
    : `release ${currentVersion} -> ${version}`,
);
console.log(`  branch     hardening, clean, at ${git(["rev-parse", "--short", "HEAD"])}`);
if (!noCommit) console.log(`  commit     branding/ztidalcode.json only, message "build: ${version}"`);
console.log(`  worktree   ${worktree} ${existsSync(worktree) ? "(reuse: re-detach to the release commit)" : "(will create)"}`);
console.log(`  signing    ${keyLabel}`);
console.log(`  build      npm run tauri -- build --config branding/ztidalcode.json`);
console.log(`             with CARGO_TARGET_DIR=${targetDir}`);
console.log(`  stale      ${stale.length ? `delete ${stale.map((f) => basename(f)).join(", ")}` : "nothing to delete"}`);
console.log(`  feed       node ${feedArgs.join(" ")}`);
console.log(`  install    ${doInstall ? `run the NSIS setup /P /R, then confirm ${installedExe} reports ${version}` : "not requested"}`);
console.log(`  draft      ${doDraft ? `stage Windows assets in draft v${version} on ${distRepo}` : "not requested"}`);

function printChecklist() {
  console.log(`
release checklist (branding/README.md — both halves of the dist repo go stale silently):
  [ ] did usage or a feature change? -> hand it to the Mac-side maintainer, who owns the
      dist README and the landing page (see MAINTAINING.md in ${distRepo}).
      This side ships releases; it does not edit those docs.
      A plain version bump needs nothing: version, download link and size come from the releases API
  [ ] git push origin hardening   (the "build: ${version}" commit is local until pushed)
  [ ] the dist repository is separate — publishing assets there pushes nothing here`);
}

if (dryRun) {
  console.log("\ndry run: nothing was written, nothing was committed.");
  printChecklist();
  process.exit(0);
}

// --- version bump: the only write this script makes to the main repository --------------------

if (!noCommit) {
  const bumped = brandingText.replace(`"version": "${currentVersion}"`, `"version": "${version}"`);
  if (bumped === brandingText) die(`could not find "version": "${currentVersion}" in branding/ztidalcode.json`);
  writeFileSync(brandingPath, bumped);
  // Staged by name: anything a concurrent session drops into the tree between the preflight
  // check and this commit stays out of it.
  git(["add", "branding/ztidalcode.json"]);
  // Pathspec form: only this file lands, whatever a concurrent session staged.
  git(["commit", "-m", `build: ${version}`, "--", "branding/ztidalcode.json"]);
  console.log(`\ncommitted "build: ${version}"`);
}

const releaseSha = git(["rev-parse", "HEAD"]);

// --- release worktree: detached at the release commit, provably free of leftovers -------------

if (!existsSync(worktree)) {
  git(["worktree", "add", "--detach", worktree, "HEAD"]);
  console.log(`created worktree ${worktree}`);
} else {
  git(["-C", worktree, "checkout", "--detach", releaseSha]);
}
if (git(["-C", worktree, "rev-parse", "HEAD"]) !== releaseSha) {
  die(`the worktree did not end up at ${releaseSha}`);
}

// The first build in a worktree rewrites src-tauri/Cargo.toml's line endings; restore it so only
// real edits count as dirt below.
git(["-C", worktree, "checkout", "--", "src-tauri/Cargo.toml"]);
const leftovers = git(["-C", worktree, "status", "--porcelain"])
  .split("\n")
  .filter((line) => line !== "")
  .filter(
    (line) =>
      line !== " M src-tauri/Cargo.toml" ||
      git(["-C", worktree, "diff", "--ignore-cr-at-eol", "--", "src-tauri/Cargo.toml"]) !== "",
  );
if (leftovers.length > 0) {
  die(
    `the release worktree is dirty — building someone's leftovers is the incident this refuses:\n` +
      `${leftovers.join("\n")}\nclean ${worktree} and rerun`,
  );
}

// Tracked files are clean; now the ignored leftovers a previous build left behind (dist/, a
// stray latest.json) — vite would bake them into the bundle without complaint. node_modules
// survives the sweep because it is recreated below only when the lockfile has moved.
git(["-C", worktree, "clean", "-fdx", "-e", "node_modules"]);

// npm ci in the worktree takes minutes for a lockfile identical to the main checkout's, so the
// installed tree is copied across instead — and re-copied when the main lockfile has moved
// since the copy, or a reused worktree builds every release against the first one's deps.
const lockfile = readFileSync(join(repoRoot, "package-lock.json"), "utf8");
const nodeModules = join(worktree, "node_modules");
const lockSnapshot = join(nodeModules, ".ztidal-lockfile-snapshot");
if (
  existsSync(nodeModules) &&
  (!existsSync(lockSnapshot) || readFileSync(lockSnapshot, "utf8") !== lockfile)
) {
  console.log("lockfile moved since node_modules was copied; refreshing...");
  rmSync(nodeModules, { recursive: true, force: true });
}
if (!existsSync(nodeModules)) {
  console.log("copying node_modules into the worktree...");
  cpSync(join(repoRoot, "node_modules"), nodeModules, { recursive: true });
  writeFileSync(lockSnapshot, lockfile);
}

// --- build ------------------------------------------------------------------------------------

const buildEnv = {
  ...cleanEnv,
  CARGO_TARGET_DIR: targetDir,
  // Contents, not a path: Tauri ignores TAURI_SIGNING_PRIVATE_KEY_PATH (branding/README.md), and
  // argv would show the key to every process on the machine — the environment of this one child
  // is the only place it may exist outside this process.
  TAURI_SIGNING_PRIVATE_KEY:
    process.env.TAURI_SIGNING_PRIVATE_KEY ?? readFileSync(keyFile, "utf8").trim(),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
};
// npm is npm.cmd on Windows; spawn cannot start it without a shell.
run("npm", ["run", "tauri", "--", "build", "--config", "branding/ztidalcode.json"], {
  cwd: worktree,
  env: buildEnv,
  shell: true,
});

// --- feed: verify + emit latest.json and SHA256SUMS.txt in the main repo root -----------------

for (const file of staleBundles()) {
  rmSync(file);
  console.log(`deleted stale ${file}`);
}

run(process.execPath, feedArgs, { cwd: repoRoot });

function builtBundle(sub, ext) {
  const dir = join(bundleDir, sub);
  const hits = existsSync(dir)
    ? readdirSync(dir).filter((n) => n.endsWith(ext) && !n.endsWith(".sig"))
    : [];
  if (hits.length !== 1) die(`expected exactly one ${ext} in ${dir}, found ${hits.length}`);
  if (!hits[0].includes(`_${version}_`)) die(`${hits[0]} is not a ${version} bundle`);
  return join(dir, hits[0]);
}

const nsis = builtBundle("nsis", "-setup.exe");
const msi = builtBundle("msi", ".msi");
const windowsAssets = [
  nsis,
  `${nsis}.sig`,
  msi,
  `${msi}.sig`,
];
const windowsBinary = join(targetDir, "release", `${binaryName}.exe`);
const windowsHandoff = buildWindowsHandoff({
  productName,
  version,
  sourceSha: releaseSha,
  windowsBinaryPath: windowsBinary,
  assetPaths: windowsAssets,
});
const windowsHandoffPath = join(
  targetDir,
  "release",
  "windows-handoff.json",
);
writeFileSync(windowsHandoffPath, `${JSON.stringify(windowsHandoff, null, 2)}\n`);
console.log(`wrote Windows provenance handoff ${windowsHandoffPath}`);

// --- install / Windows draft handoff ----------------------------------------------------------

const draftArgs = [
  "release",
  "create",
  `v${version}`,
  "--repo",
  distRepo,
  "--title",
  `${productName} ${version}`,
  "--draft",
  ...(notesFile ? ["--notes-file", notesFile] : ["--notes", notesText]),
  ...windowsAssets,
];

if (doInstall) {
  // Tauri's NSIS switches: /P passive (progress bar, no questions), /R relaunch the app after.
  run(nsis, ["/P", "/R"]);
  const ps = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${installedExe.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
    { encoding: "utf8", env: cleanEnv },
  );
  if (ps.status !== 0) die(`could not read ${installedExe}: ${(ps.stderr || "").trim()}`);
  const installed = ps.stdout.trim();
  // The version resource pads to four numbers (X.Y.Z.0), so a prefix match is the exact check.
  if (installed !== version && !installed.startsWith(`${version}.`)) {
    die(`${installedExe} reports ${installed}, expected ${version} — the install did not take`);
  }
  console.log(`installed and verified: ${installedExe} reports ${installed}`);
}

if (doDraft) {
  // The Windows builder never flips the release live. macOS bundles and the
  // complete cross-platform feed do not exist on this machine; publishing
  // here would make every Mac client see an incomplete latest.json.
  let remoteTag;
  try {
    remoteTag = readRemoteGitTag({
      repo: distRepo,
      tag: `v${version}`,
      env: cleanEnv,
    });
    assertRemoteGitTagAbsent(remoteTag, {
      repo: distRepo,
      tag: `v${version}`,
    });
  } catch (error) {
    die(error.message);
  }
  const release = readReleaseTag({
    repo: distRepo,
    tag: `v${version}`,
    env: cleanEnv,
  });
  try {
    assertWindowsReleaseTagAbsent(release, {
      repo: distRepo,
      tag: `v${version}`,
    });
  } catch (error) {
    die(error.message);
  }
  run("gh", draftArgs);
  console.log(`staged Windows assets in draft v${version}; the Mac-side release owner will finalize it`);
}

if (!doInstall && !doDraft) {
  console.log(`\nartifacts verified; stopping here (no --install / --draft).`);
  console.log(`--install would run:`);
  console.log(`  ${nsis} /P /R`);
  console.log(`  then confirm ${installedExe} reports ${version}`);
  console.log(`--draft would run:`);
  console.log(`  gh ${draftArgs.join(" ")}`);
  console.log(`  and leave v${version} as a draft for the Mac-side release owner`);
}

printChecklist();
