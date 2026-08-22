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

Source lives in the private `ztidal/ZtidalCode`. Installers, `latest.json` and its `.sig` go to the public
`ztidal/ZtidalCode-dist`, because GitHub release assets on a private repository require authentication and
the updater fetches them anonymously.

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

## Publishing a release

Build through the overlay, then generate the feed from the bundles that build produced:

```bash
npm run updater:json -- --notes "what changed in this release"
gh release create v0.0.9 --repo ztidal/ZtidalCode-dist \
  latest.json \
  src-tauri/target/release/bundle/nsis/*-setup.exe* \
  src-tauri/target/release/bundle/msi/*.msi*
```

`make-updater-json.mjs` verifies every signature against the bundle bytes before it writes the feed, and
refuses to write one it cannot verify. A feed whose signature came from a different build than the artifact
it points at looks perfectly healthy from the outside and fails on every client at install time; it is the
one packaging mistake worth spending a check on.

### The macOS half

macOS is built on a Mac, by the macOS side, from the source tag the Windows release created —
never from a branch head, because the feed claims a version and the build must be that version.
It applies a second overlay after the first so its updater reads a feed of its own:

```bash
npm run tauri -- build --config branding/ztidalcode.json --config branding/ztidalcode-mac.json \
  --target universal-apple-darwin
node scripts/make-updater-json.mjs --platform macos --arch universal --notes-file NOTES.md \
  --bundle-dir src-tauri/target/universal-apple-darwin/release/bundle
```

That writes `latest-mac.json` and `SHA256SUMS-mac.txt`, which the macOS side uploads to the
existing release alongside its archive, `.sig` and DMG. Two feed files, not one merged feed: two
machines publishing into one release must never write the same file. The full procedure and the
rules live in `MAINTAINING.md` in the dist repository.

### One platform key per installer kind

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
