#!/usr/bin/env bash
# token.sh — print a fresh GitHub App installation token (≤ 1 h) to stdout.
#
# Usage in other sessions:
#   export GITHUB_TOKEN=$(token.sh)   # gh CLI and curl read $GITHUB_TOKEN
# (raw git needs Basic auth — see docs/token.md → "Raw git commands")
#
# Only the token goes to stdout; diagnostics and expiry go to stderr.
set -euo pipefail

cd "$(dirname "$0")"   # repo root
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

# Credentials + key (fail loud, names the missing item); exports KEY_PATH.
source lib/env.sh

exec node src/auth.mjs --token
