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

## Signing

The updater only accepts artifacts signed by the private key matching `plugins.updater.pubkey` above.
That key is **not** in this repository. Point the build at it with:

```bash
export TAURI_SIGNING_PRIVATE_KEY_PATH=/path/to/ztidalcode.key
npm run tauri -- build --config branding/ztidalcode.json
```

Because our installers carry no Authenticode signature, this minisign key is the only integrity guarantee
on an update. Losing it means no future build can update an installed client; leaking it means anyone can.

## Where releases go

Source lives in the private `ztidal/ZtidalCode`. Installers, `latest.json` and its `.sig` go to the public
`ztidal/ZtidalCode-dist`, because GitHub release assets on a private repository require authentication and
the updater fetches them anonymously.
