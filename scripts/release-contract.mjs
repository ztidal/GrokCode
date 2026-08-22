import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export function sanitizedReleaseEnvironment(environment) {
  const clean = { ...environment };
  delete clean.TAURI_SIGNING_PRIVATE_KEY;
  delete clean.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  return clean;
}

/** List every matching release, including duplicate drafts; any lookup error is fatal. */
export function readReleaseTag({ repo, tag, run = spawnSync, env }) {
  const result = run(
    "gh",
    [
      "release",
      "list",
      "--repo",
      repo,
      "--limit",
      "1000",
      "--json",
      "tagName,isDraft",
    ],
    { encoding: "utf8", ...(env ? { env } : {}) },
  );
  if (result.status !== 0) {
    const detail = result.error?.message ?? `${result.stderr ?? result.stdout ?? ""}`.trim();
    throw new Error(
      `release lookup failed with exit code ${result.status ?? "unknown"}${detail ? `: ${detail}` : ""}`,
    );
  }
  let releases;
  try {
    releases = JSON.parse(`${result.stdout ?? ""}`);
  } catch (error) {
    throw new Error(`release lookup returned invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(releases)) {
    throw new Error("release lookup did not return an array");
  }
  const matches = releases.filter((release) => release?.tagName === tag);
  if (matches.length === 0) return { found: false };
  return {
    found: true,
    isDraft: matches.every((release) => release.isDraft === true),
    count: matches.length,
  };
}

/** Resolve one exact remote tag; status 2 means absent, every other lookup failure is fatal. */
export function readRemoteGitTag({ repo, tag, run = spawnSync, env }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`invalid GitHub repository ${repo}`);
  }
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`invalid release tag ${tag}`);
  }
  const ref = `refs/tags/${tag}`;
  const result = run(
    "git",
    [
      "ls-remote",
      "--exit-code",
      `https://github.com/${repo}.git`,
      ref,
    ],
    { encoding: "utf8", ...(env ? { env } : {}) },
  );
  if (result.status === 2) return { found: false };
  if (result.status !== 0) {
    const detail = `${result.stderr ?? result.stdout ?? ""}`.trim();
    throw new Error(
      `remote tag lookup failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const match = `${result.stdout ?? ""}`.trim().match(
    new RegExp(`^([0-9a-f]{40})\\s+${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  );
  if (!match) throw new Error(`remote tag lookup returned malformed output for ${ref}`);
  return { found: true, sha: match[1].toLowerCase() };
}

/** Windows gets one immutable staging attempt; any existing tag is Mac-owned recovery work. */
export function assertWindowsReleaseTagAbsent(release, { repo, tag }) {
  if (!release?.found) return;
  if (release.isDraft) {
    throw new Error(
      `${tag} already exists as a draft on ${repo}; Windows staging is immutable, so delete the failed draft explicitly before rebuilding`,
    );
  }
  throw new Error(`${tag} is already published on ${repo}`);
}

export function assertRemoteGitTagAbsent(remoteTag, { repo, tag }) {
  if (remoteTag?.found) {
    throw new Error(
      `${tag} already exists as a git tag on ${repo} at ${remoteTag.sha}; delete the stale tag explicitly before Windows staging`,
    );
  }
}

function fileDigest(path) {
  return {
    name: basename(path),
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

/** Machine-readable Windows artifacts that the Mac finalizer must receive and verify. */
export function buildWindowsHandoff({
  productName,
  version,
  sourceSha,
  windowsBinaryPath,
  assetPaths,
}) {
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) {
    throw new Error("sourceSha must be a full 40-character Git commit SHA");
  }
  if (basename(windowsBinaryPath) !== "PinkCode.exe") {
    throw new Error("Windows handoff binary must be PinkCode.exe");
  }
  const expectedAssets = [
    `${productName}_${version}_x64-setup.exe`,
    `${productName}_${version}_x64-setup.exe.sig`,
    `${productName}_${version}_x64_en-US.msi`,
    `${productName}_${version}_x64_en-US.msi.sig`,
  ];
  if (
    JSON.stringify(assetPaths.map((path) => basename(path))) !==
    JSON.stringify(expectedAssets)
  ) {
    throw new Error(
      `Windows handoff assets do not exactly match version ${version}: expected ${expectedAssets.join(", ")}`,
    );
  }
  return {
    version,
    sourceSha,
    files: [fileDigest(windowsBinaryPath), ...assetPaths.map(fileDigest)],
  };
}
