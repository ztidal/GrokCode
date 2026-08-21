# Renaming the product

Status: Parked — the name is undecided. Everything below was measured on
2026-08-22 against 0.0.30, so it does not need finding again.

## What the name is actually made of

`branding/ztidalcode.json` carries `productName`, `identifier` and the updater
endpoint. Everything else that says the name is documentation, a data path, or
a string in the UI.

| | |
| --- | --- |
| `ZtidalCode` | 41 occurrences, 17 files |
| `ztidalcode` | 58 occurrences, 23 files |
| `ztidal` | 75 occurrences, 25 files (includes the GitHub org) |

## The two things that make it more than a find-and-replace

**Existing installs will not upgrade.** The uninstall entry is keyed on the
product name — verified on this machine, the registry key is literally
`ZtidalCode` and the install location is `%LOCALAPPDATA%\ZtidalCode`. A build
with a different `productName` installs *beside* the old one and leaves it
running, still polling the old feed. Either the new installer removes the old
one, or every person uninstalls by hand once.

**The updater endpoint is a URL.** Renaming `ZtidalCode-dist` breaks
`releases/latest/download/latest.json` for everybody who has not updated yet,
and they stop updating permanently rather than noisily. If the repository is
renamed, ship a release under the old name first that points at the new
endpoint, then rename.

## Things worth doing at the same time

- The main binary is still `PinkCode.exe`. `mainBinaryName` was never set in the
  overlay, so the installed executable has carried upstream's name the whole
  time.
- `~/.ztidalcode` holds session titles, task preferences, usage, logs and pasted
  screenshots. `config.rs` already walks a list of predecessor directories
  (`.pinkcode`, then `.ztidalcode`) — a rename appends to that list rather than
  needing new machinery.

## On `GrokCode` specifically

It puts xAI's mark in the product name of a third-party client that is publicly
downloadable, which is what the current name was chosen to avoid. Flagged, not
decided.
