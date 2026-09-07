# Rename the package, not the protocol

The app ships as **GrokCode** with bundle identifier `com.grokcode.app`, but the identity it presents on
the wire to Grok Build is still upstream's: `acp/protocol.rs` sends `clientInfo.name = "pinkcode"` and
`gateway.rs` uses the `_pinkcode/` JSON-RPC method prefix. Those two are protocol values, not branding —
renaming them changes what the agent sees, for no benefit to us.

Product name, the shipped binary name (`GrokCode.exe`), bundle identifier and the updater's trust
anchor live in `branding/grokcode.json` and are merged at build time (`--config`), so
`src-tauri/tauri.conf.json` — which upstream edited in 15 of its last 30 commits — stays untouched.
The Cargo `[[bin]]` name has to match `mainBinaryName` or Tauri cannot find the executable; that one
line in `Cargo.toml` is the exception. Title bars and `index.html` carry the product name in the UI.

## Consequences

The name is inconsistent by design: an installed **GrokCode** identifies itself to Grok Build as
`pinkcode`, and the crate, log target and internal helpers still say `pinkcode` throughout. That is
intended. A future contributor tidying this up would change wire behaviour and multiply merge
conflicts; leave it.

Host state prefers `~/.grokcode`. If that folder is missing and `~/.ztidalcode` already exists (the
previous product name), that directory is used instead so pins, titles and prefs survive. Upstream
PinkCode stays on `~/.pinkcode`; the apps must not share a config file.

Windows NSIS keys the uninstall entry on `productName`. A rename therefore installs *beside* the old
app unless the previous install is removed. That is expected once, and belongs in the release notes.
