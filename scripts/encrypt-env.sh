#!/usr/bin/env bash
# Make an encrypted copy of .env for a password manager.
#
# You run this, not Claude. The passphrase is prompted, never echoed, never
# passed as an argument (arguments are visible in `ps`), and never written
# anywhere. If an assistant chose or handled the passphrase, encrypting would be
# theatre — the secret and its key would sit together in the same transcript.
#
#   npm run encrypt:env
#
# To restore later:
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in env.enc -out .env
set -euo pipefail

IN=${1:-.env}
OUT=${2:-env.enc}
ITER=600000

[ -f "$IN" ] || { echo "  $IN not found"; exit 1; }
command -v openssl >/dev/null || { echo "  openssl is required"; exit 1; }

if [ -f "$OUT" ]; then
  printf '  %s already exists. Overwrite? [y/N] ' "$OUT"
  read -r reply </dev/tty
  case "$reply" in [yY]*) ;; *) echo "  aborted."; exit 1;; esac
fi

echo "  Encrypting $IN -> $OUT (AES-256-CBC, PBKDF2, $ITER iterations)."
echo "  Choose a passphrase you can retrieve from your password manager."
echo "  If you lose it, this file is unrecoverable. That is the point."
echo

# -pass stdin keeps the passphrase off the command line. Read it once, confirm
# it, and hold it only in this shell's memory.
printf '  Passphrase: '        >&2; stty -echo; read -r PASS  </dev/tty; stty echo; echo >&2
printf '  Confirm:    '        >&2; stty -echo; read -r PASS2 </dev/tty; stty echo; echo >&2
[ "$PASS" = "$PASS2" ] || { echo "  passphrases did not match."; exit 1; }
[ ${#PASS} -ge 12 ] || { echo "  use at least 12 characters — this protects live credentials."; exit 1; }

printf '%s' "$PASS" | openssl enc -aes-256-cbc -pbkdf2 -iter "$ITER" -salt \
  -in "$IN" -out "$OUT" -pass stdin

# An encrypted file that does not decrypt is not a backup. Prove it round-trips
# to the exact original before telling anyone it worked.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
printf '%s' "$PASS" | openssl enc -d -aes-256-cbc -pbkdf2 -iter "$ITER" \
  -in "$OUT" -out "$TMP" -pass stdin 2>/dev/null || { echo "  VERIFY FAILED: cannot decrypt."; rm -f "$OUT"; exit 1; }

A=$(shasum -a 256 < "$IN"  | cut -d' ' -f1)
B=$(shasum -a 256 < "$TMP" | cut -d' ' -f1)
[ "$A" = "$B" ] || { echo "  VERIFY FAILED: decrypted copy differs from the original."; rm -f "$OUT"; exit 1; }
unset PASS PASS2

echo "  Wrote $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes) — decrypt verified byte-for-byte."
echo
echo "  NOW MOVE IT OFF THIS MACHINE. A backup that only exists on the machine"
echo "  it protects is not a backup. Put it in your password manager, or any"
echo "  storage you can reach after this laptop is gone."
echo
echo "  It is gitignored: this repository is public, and an encrypted blob in it"
echo "  would be an offline brute-force target that never expires."
