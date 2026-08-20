# Rename the package, not the protocol

The app ships as **ZtidalCode** with bundle identifier `com.ztidal.code`, but the identity it presents on
the wire to Grok Build is still upstream's: `acp/protocol.rs` sends `clientInfo.name = "pinkcode"` and
`gateway.rs` uses the `_pinkcode/` JSON-RPC method prefix. Those two are protocol values, not branding —
renaming them changes what the agent sees, for no benefit to us.

Product name, bundle identifier and the updater's trust anchor live in `branding/ztidalcode.json` and are
merged at build time (`--config`), so `src-tauri/tauri.conf.json` — which upstream edited in 15 of its last
30 commits — stays untouched. Only four source strings changed: the two title bars and two in `index.html`.

## Consequences

The name is inconsistent by design: an installed **ZtidalCode** stores state in `~/.ztidalcode` but
identifies itself to Grok Build as `pinkcode`, and the crate, log target and internal helpers still say
`pinkcode` throughout. That is intended. A future contributor tidying this up would change wire behaviour
and multiply merge conflicts; leave it.

The config directory *was* renamed (`~/.pinkcode` → `~/.ztidalcode`) because we ship a different bundle
identifier and the two apps can be installed side by side — two distinct applications sharing one config
file is worse than an inconsistent name.
