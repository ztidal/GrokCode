#!/usr/bin/env bash
#
# Encrypt the updater signing key so it can be stored off this machine.
#
# The key is the only integrity guarantee on an update — our installers carry no Authenticode
# signature. Losing it means no future build can update an installed client; leaking it means anyone
# can. So it needs to exist in a second place, and it must not sit there in the clear.
#
# gpg asks for the passphrase itself. Run this from your own terminal: the passphrase must not pass
# through a script argument, an environment variable, or an agent's transcript.
#
# Usage:
#   scripts/backup-signing-key.sh <path-to-ztidalcode.key> [output-dir]
#
# Restoring:
#   gpg --output ztidalcode.key --decrypt ztidalcode.key.gpg
set -euo pipefail

key="${1:-}"
if [ -z "$key" ]; then
    echo "usage: $0 <path-to-ztidalcode.key> [output-dir]" >&2
    exit 64
fi
if [ ! -f "$key" ]; then
    echo "no such key: $key" >&2
    exit 66
fi

out_dir="${2:-$(dirname "$key")}"
mkdir -p "$out_dir"
out="$out_dir/$(basename "$key").gpg"

if [ -e "$out" ]; then
    echo "refusing to overwrite an existing backup: $out" >&2
    echo "move it aside first — an older backup may be the only copy of an older key." >&2
    exit 73
fi

echo "encrypting $key"
echo "  -> $out"
echo
echo "gpg will ask for a passphrase twice. Put it in your password manager now, not later:"
echo "without it this backup is as lost as the key it is protecting."
echo

# --s2k-count is the maximum gpg accepts; the key derivation is the only thing standing between
# this file and the signing key if the backup ever ends up somewhere it should not be.
gpg --symmetric \
    --cipher-algo AES256 \
    --digest-algo SHA512 \
    --s2k-mode 3 \
    --s2k-digest-algo SHA512 \
    --s2k-count 65011712 \
    --output "$out" \
    "$key"

# A backup that does not restore is worse than no backup, because you stop looking for the key.
echo
echo "verifying the backup restores to identical bytes..."
probe="$(mktemp)"
trap 'rm -f "$probe"' EXIT
gpg --quiet --yes --output "$probe" --decrypt "$out"

if cmp -s "$key" "$probe"; then
    echo "  ok — $(wc -c < "$out" | tr -d ' ') bytes of ciphertext restore to the original key"
else
    echo "  FAILED — the backup does not restore to the original key. Do not rely on it." >&2
    rm -f "$out"
    exit 70
fi

echo
echo "done. Commit ONLY $(basename "$out"). The plaintext key must never be committed anywhere."
