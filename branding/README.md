# Build-time identity overlay

`ztidalcode.json` is merged over `src-tauri/tauri.conf.json` at build time:

```bash
npm run tauri -- build --config branding/ztidalcode.json
```

Everything that distinguishes our build from upstream's — product name, bundle identifier, and the
updater's trust anchor and feed — lives here rather than in `src-tauri/tauri.conf.json`.

## Why an overlay instead of editing the config

`src-tauri/tauri.conf.json` is one of the files upstream touches most (15 of its last 30 commits, almost
all version bumps). Editing it in place would put a guaranteed merge conflict in front of every upstream
sync, forever, in exchange for four values. This file is one upstream will never touch, so the same four
values cost nothing to carry.

## Versioning

We carry our own version line (`0.0.1`, `0.0.2`, …), independent of upstream's. Upstream's number says
nothing about which hardening patches a build contains, and the updater compares our feed against our
build — so the two lines must not be shared.

Windows Installer constrains what the version may be, and Tauri enforces it at bundle time:

- major ≤ 255 (`2026.8.20` is rejected: "app version major number cannot be greater than 255")
- build metadata must be numeric-only and ≤ 65535 (`+ztidal.1` is rejected; `+1` is accepted)

A date scheme is therefore possible only as `26.8.20+1`, not `2026.8.20+ztidal.1`.

## Signing

The updater only accepts artifacts signed by the private key matching `plugins.updater.pubkey` above.
That key is **not** in this repository.

Tauri 2.11 reads the key from `TAURI_SIGNING_PRIVATE_KEY` as the key's *contents*. It does **not** honour
`TAURI_SIGNING_PRIVATE_KEY_PATH`, despite `tauri signer generate` printing it as an option — a build with
only the path set produces unsigned bundles and fails at the end with "a public key has been found, but no
private key".

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat /path/to/ztidalcode.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri -- build --config branding/ztidalcode.json
```

Because our installers carry no Authenticode signature, this minisign key is the only integrity guarantee
on an update. Losing it means no future build can update an installed client; leaking it means anyone can.

The same minisign key protects Windows and macOS updater artifacts, but it is not an operating-system code
signing identity. Windows installers have no Authenticode signature, and the Mac app has no Apple Developer
ID signature or notarization. Those omissions cause SmartScreen and Gatekeeper warnings on first install;
they do not disable the independent minisign verification performed by the in-app updater.

### Backing it up

The key file's own passphrase is empty — that is why the build passes
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""` — so nothing protects it at rest except where you keep it. It has
to exist in a second place, and it has to be encrypted there:

```bash
scripts/backup-signing-key.sh /path/to/ztidalcode.key
```

Run it from your own terminal: gpg asks for the passphrase itself, and a passphrase typed into a script
argument, an environment variable, or an agent's transcript is not a passphrase any more. The script
refuses to finish unless the ciphertext decrypts back to the original bytes — a backup that does not
restore is worse than none, because it stops you looking for the key.

Commit only the `.gpg`. Restoring is `gpg --output ztidalcode.key --decrypt ztidalcode.key.gpg`.

Minisign has no command to change a key's passphrase, so giving this key a real one means generating a new
key — and every client already installed trusts the old public key and would have to be reinstalled by
hand once. That is the trade to weigh when deciding, not a thing to do casually.

## Where releases go

Source lives in the private `ztidal/ZtidalCode`. Installers, updater archives and their `.sig` files,
`latest.json`, and `SHA256SUMS.txt` go to the public `ztidal/ZtidalCode-dist`, because GitHub release assets
on a private repository require authentication and the updater fetches them anonymously. The manifest is
not separately signed: each platform entry contains the minisign signature for the exact artifact it
downloads.

Build the feed with `npm run updater:json`; it verifies every signature against the bundle bytes before
writing, so a feed cannot ship a signature from a different build than the artifact it points at.

### What a release includes besides the bundles

The dist repository is the only thing anyone outside this repo reads, and both halves of it go stale
silently — nothing fails, the words are just wrong. So a release also means:

- **`README.md` — the usage guide.** Anything the release changed about how the app is used. It had
  drifted three releases before anyone noticed a pin no longer did what it said.
- **`docs/index.html` — the landing page.** Only when a *feature* changes. The version, download link and
  file size come from the releases API at load, so a plain version bump needs nothing here, and the app
  in the hero is drawn from the same tokens the app uses rather than screenshotted, so a UI change does
  not leave a stale picture behind. Published from `main` under `/docs`:
  [ztidal.github.io/ZtidalCode-dist](https://ztidal.github.io/ZtidalCode-dist/).

## Publishing a cross-platform release

The **Windows PC builds Windows**. The **Mac release owner owns the release**: it fixes the version and
source commit, builds Apple Silicon, receives the Windows artifacts, creates the complete manifest, updates
the dist documentation, and is the only side that turns the GitHub draft into a public release. The Windows
helper can create that draft with `--draft`, but it refuses any existing tag and has no path that publishes
it: a Windows-only `latest.json` must never become the live update channel.

### One version, one source commit

Both machines must build the exact same clean `hardening` commit. A matching version number is not enough:
two different trees can both call themselves `X.Y.Z`, and the release would then describe no reproducible
source state.

1. The Mac release owner integrates the release changes, sets `branding/ztidalcode.json` to the new version,
   runs the complete checks, commits, and pushes `hardening`.
2. The owner sends the Windows operator the full output of `git rev-parse HEAD` and the version. Do not send
   a branch name by itself; it can move between checkout and build.
3. Each machine checks out that commit and records the same full SHA in the handoff. Signing-key material
   is restored independently on each machine and never travels with the artifacts, notes, hashes, or logs.
4. If either tree or version changes, both platforms rebuild. Never combine a fresh Mac bundle with a
   Windows bundle from an earlier commit or version.

The Windows PC uses the release helper as a clean-worktree builder, verifier, and draft stager. With the
version bump already committed by the owner, run this from a clean `hardening` branch:

```powershell
npm ci
npm run release -- --no-commit --notes-file C:\release\ZtidalCode-NOTES.md --key C:\secure\ztidalcode.key --draft
git rev-parse HEAD
```

Keep the notes file outside the checkout: the helper deliberately refuses an untracked or otherwise dirty
release tree.

The command generates a Windows-only feed and checksums locally so it can verify the build, then creates
draft `v<version>` with only these four release assets; it never uploads the partial metadata
or makes the draft public:

- `ZtidalCode_<version>_x64-setup.exe` and its `.sig`
- `ZtidalCode_<version>_x64_en-US.msi` and its `.sig`

Windows staging is immutable. If that exact tag already exists, the helper refuses to upload or
`--clobber` anything. After a failed staging attempt, the Mac release owner must inspect and explicitly
delete the failed draft and its tag before Windows retries; never turn a partial draft into an in-place
restage:

```bash
gh release delete "v<version>" \
  --repo ztidal/ZtidalCode-dist \
  --cleanup-tag \
  --yes
```

The out-of-band handoff to the Mac owner also needs the full source SHA, version, and
`src-tauri/target/release/PinkCode.exe`, plus the generated
`src-tauri/target/release/windows-handoff.json`. The JSON binds the full source SHA to SHA-256 hashes of
the raw executable and all four Windows release assets. The raw executable and JSON are **provenance
inputs, not release assets**: the Mac finalizer recalculates their hashes, and the feed generator inspects
the executable to prove that the installers were built with ZtidalCode's updater key rather than
upstream's. Transfer both out of band; never upload them or substitute files from another build.

### Stage the Windows handoff before finalizing

On an Apple Silicon Mac, run `npm ci` in the clean checkout, then place the Windows handoff into the
fixed release paths below. The raw Windows executable and handoff JSON stay one level above `bundle`:

```text
src-tauri/target/release/
├── PinkCode.exe                              # provenance only; do not upload
├── windows-handoff.json                      # provenance only; do not upload
└── bundle/
    ├── nsis/ZtidalCode_<version>_x64-setup.exe{,.sig}
    └── msi/ZtidalCode_<version>_x64_en-US.msi{,.sig}
```

Do not prebuild or copy Mac artifacts into this tree. The finalizer deliberately ignores any old
`src-tauri/target/release/bundle/dmg` or `bundle/macos` contents. It builds the Mac-owned artifacts once
from the verified checkout in a new temporary `CARGO_TARGET_DIR`, using the explicit
`aarch64-apple-darwin` target, and removes that directory on both success and failure.

Transfer `PinkCode.exe` and `windows-handoff.json` out of band. The four public Windows assets can be
downloaded from the authenticated draft and placed in their fixed directories on the Mac:

```bash
ZTIDAL_VERSION="$(node -p "require('./branding/ztidalcode.json').version")"
ZTIDAL_WINDOWS="$(mktemp -d)"
gh release download "v${ZTIDAL_VERSION}" \
  --repo ztidal/ZtidalCode-dist \
  --pattern "ZtidalCode_${ZTIDAL_VERSION}_x64*" \
  --dir "${ZTIDAL_WINDOWS}"
mkdir -p src-tauri/target/release/bundle/nsis src-tauri/target/release/bundle/msi
cp "${ZTIDAL_WINDOWS}/ZtidalCode_${ZTIDAL_VERSION}_x64-setup.exe"{,.sig} \
  src-tauri/target/release/bundle/nsis/
cp "${ZTIDAL_WINDOWS}/ZtidalCode_${ZTIDAL_VERSION}_x64_en-US.msi"{,.sig} \
  src-tauri/target/release/bundle/msi/
```

From that Windows-only staging tree, run the fail-closed Mac finalizer with the exact source SHA. The
private key is selected in this order: a non-empty `TAURI_SIGNING_PRIVATE_KEY`, `--key`, then
`ZTIDAL_SIGNING_KEY_FILE`. The password, if any, is accepted only through
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`:

```bash
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run release:finalize -- \
  --expected-sha "$(git rev-parse HEAD)" \
  --windows-handoff src-tauri/target/release/windows-handoff.json \
  --notes-file /path/to/ZtidalCode-NOTES.md \
  --key /path/to/ztidalcode.key
```

The finalizer requires a clean `hardening` checkout at that full SHA, recalculates all five Windows
handoff hashes, snapshots their bytes into the fresh target, and requires the exact GitHub release to
still be a draft containing only those four public Windows assets with matching digests. It gives the
signing key only to the native build child; Git, the feed generator, and GitHub CLI run without the key or
password. The combined generator verifies the signatures and both platform binaries before creating one
`latest.json`. Immediately before upload, the finalizer rechecks the source, staged bytes, notes, metadata,
and draft digests. It then uploads the fresh arm64 DMG, app archive, archive signature, and two metadata
files without `--clobber`, updates the title and notes, checks for exactly nine assets with matching
digests, and deliberately leaves the release as a draft.

The `.dmg` is for a person installing the app; the updater downloads `ZtidalCode.app.tar.gz`. We currently
publish Apple Silicon only. Do not add `darwin-x86_64` keys unless a matching Intel archive has actually
been built, signed, and verified.

If upload or release editing fails after some Mac-owned files have reached the draft, it stays safely
unpublished. Inspect the draft, delete any of these five partial assets with
`gh release delete-asset <tag> <name> --repo ztidal/ZtidalCode-dist --yes`, then rerun the finalizer:
`latest.json`, `SHA256SUMS.txt`, the arm64 DMG, `ZtidalCode.app.tar.gz`, and its `.sig`. Do not recover with
`--clobber`, because that would hide which state was actually verified.

The generated feed's top-level `version`, `notes`, and `pub_date` describe the same release, and its
`platforms` object contains all five entries:

| Key | Artifact |
|---|---|
| `windows-x86_64-nsis` | `ZtidalCode_<version>_x64-setup.exe` |
| `windows-x86_64` | the same NSIS setup, as the Windows fallback |
| `windows-x86_64-msi` | `ZtidalCode_<version>_x64_en-US.msi` |
| `darwin-aarch64-app` | `ZtidalCode.app.tar.gz` |
| `darwin-aarch64` | the same app archive, as the macOS fallback |

Tauri looks for `{os}-{arch}-{installer}` first and `{os}-{arch}` second. Omitting either Darwin entry is
avoidable ambiguity; replacing the manifest with a Mac-only or Windows-only object breaks updates for the
other platform. `SHA256SUMS.txt` uses the flat GitHub asset names and covers the Windows installers, the
DMG, the app updater archive, and the Mac archive signature.

Verify the complete manifest, checksums, release notes, and every uploaded artifact before making it public.
At minimum:

- every manifest URL names the same release tag and returns the expected bytes;
- every embedded signature verifies those exact bytes with the branding public key;
- the app/installer versions and recorded source SHA match;
- mount the DMG and confirm its app version and arm64 executable match the signed updater archive;
- the five keys above are present and the release body matches `latest.json` notes;
- the dist README and Pages describe the controls and platforms that actually shipped.

Only after all checks pass should the Mac owner run:

```bash
ZTIDAL_VERSION="$(node -p "require('./branding/ztidalcode.json').version")"
gh release edit "v${ZTIDAL_VERSION}" --repo ztidal/ZtidalCode-dist --draft=false
```

Draft-first matters because
`releases/latest/download/latest.json` must never point clients at a half-uploaded release.

A feed whose signature came from a different build than the artifact it points at looks perfectly healthy
from the outside and fails on every client at install time; it is the one packaging mistake worth spending
a check on.

### One Windows key per installer kind

The feed carries `windows-x86_64-nsis`, `windows-x86_64-msi` and a generic `windows-x86_64`. This is not
redundancy. The updater looks up `{os}-{arch}-{installer}` first and only then falls back to `{os}-{arch}`,
and it does not guess the installer at runtime — the bundler stamps it into each binary
(`__TAURI_BUNDLE_TYPE_VAR_MSI` / `..._NSS`), so the copy inside the MSI and the copy inside the NSIS
installer ask for different keys.

A feed carrying only the generic key hands an MSI-installed client the NSIS installer. That installs
cleanly — the NSIS installer removes the MSI install first — but it moves the app from
`%LOCALAPPDATA%\Programs\ZtidalCode` to `%LOCALAPPDATA%\ZtidalCode`, which leaves whatever the user pinned
to their taskbar pointing at nothing. The generic key stays in the feed as the fallback for a client whose
installer kind cannot be determined; NSIS is the right answer there because it needs no administrator.

### Which installer to hand people

The two are not interchangeable, and the difference only shows up at update time:

| | NSIS `-setup.exe` | MSI |
|---|---|---|
| Scope | per-user (`RequestExecutionLevel user`) | per-machine (`ALLUSERS=1`) |
| Install | no prompt | UAC |
| **In-app update** | **silent: passive install, no prompt, app relaunches itself** | **UAC every time** |

The MSI package does not set the summary-information bit that marks elevation as unnecessary, and the
updater runs `msiexec` without `MSIINSTALLPERUSER`, so an MSI client cannot update without an administrator.
Hand individuals the `.exe`. The MSI is for administrator-driven rollout, where updates are managed
centrally anyway.
