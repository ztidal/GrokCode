# Security

GrokCode ships self-updating desktop binaries, so the questions that matter are which build is
supported, how an update earns trust, what the app does with credentials, and where to report a problem.

## Supported versions

Only the latest release on [GrokCode-dist](https://github.com/ztidal/GrokCode-dist/releases) is
supported. Installed clients check that feed at every launch and update themselves, so a fix ships as
the next release rather than as a patch to an older version.

## How an update is trusted

Every update artifact carries a [minisign](https://jedisct1.github.io/minisign/) signature, and the
updater verifies it against a public key compiled into the build through the identity overlay:
`plugins.updater.pubkey` in [`branding/grokcode.json`](branding/grokcode.json). An artifact whose
signature does not verify against that key is not installed, whoever serves it. The matching private key
is not in this repository; [`branding/README.md`](branding/README.md#signing) describes how it is kept
and what losing or leaking it would mean. The feed itself (`latest.json`, `latest-mac.json`) is generated
by [`scripts/make-updater-json.mjs`](scripts/make-updater-json.mjs), which verifies each signature
against the bundle bytes before it will write a feed that points at them.

A first install is trusted differently. The Windows installers carry no Authenticode signature, and the
macOS build is ad-hoc signed — not Developer ID signed, not notarized — so the operating system warns on
both. Check a download against the checksum list published on the same release before installing it:
`SHA256SUMS.txt` for the Windows `.exe` and `.msi`, `SHA256SUMS-mac.txt` for the macOS `.dmg`.

## Credentials

The app asks for none and stores none of its own. It reuses the session that `grok login` creates under
`~/.grok` (`%USERPROFILE%\.grok` on Windows) and sends that token to exactly two places, both of which the
Grok CLI itself talks to: the OIDC issuer recorded in `auth.json`, to refresh the token when it expires,
and Grok's billing API, for the usage figures the app displays. It is never sent to the release feed, the
dist repository, or anywhere else. `auth.json` is rewritten atomically and kept owner-only; that is one
of the hardening changes listed in the README.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository: the **Security** tab, then
**Report a vulnerability**. That keeps the report between you and the maintainers until a fix is
released, which matters for an app that updates itself — a published report describes every installed
client at once. Do not open a public issue for a security problem.

Vulnerabilities in code inherited from [upstream PinkCode](https://github.com/3xian/PinkCode) affect this
build too; report them here anyway and the maintainers will coordinate with upstream.

What to expect: an acknowledgement that the report was read; the fix in the next release, which every
installed client picks up on its own; and credit in the release notes if you want it.
