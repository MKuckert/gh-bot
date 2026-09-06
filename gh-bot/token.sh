#!/usr/bin/env bash
# token.sh — print a fresh GitHub App installation token (≤ 1 h) to stdout.
#
# Usage in other sessions:
#   export GITHUB_TOKEN=$(gh-bot/token.sh)   # git push / gh CLI then just work
# (the repo's git credential helper and the gh CLI both read $GITHUB_TOKEN)
#
# Only the token goes to stdout; diagnostics and expiry go to stderr.
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root
if [[ -f .env ]]; then set -a; source ./.env; set +a; fi
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

missing=()
for v in GH_APP_ID GH_INSTALLATION_ID; do
    [[ -n "${!v:-}" ]] || missing+=("$v")
done
if (( ${#missing[@]} )); then
    echo "token.sh: missing env var(s): ${missing[*]} — expected in .env at repo root" >&2
    exit 1
fi
if [[ ! -f gh-bot/key.pem ]]; then
    echo "token.sh: missing gh-bot/key.pem (app private key)" >&2
    exit 1
fi

node -e '
import("./gh-bot/auth.mjs").then(async ({ AppAuth }) => {
    const auth = new AppAuth({
        appId: process.env.GH_APP_ID,
        installationId: process.env.GH_INSTALLATION_ID,
        pemPath: "gh-bot/key.pem",
    });
    const token = await auth.getToken();
    console.error(`token.sh: valid until ${new Date(auth.cached.expiresAt * 1000).toISOString()}`);
    console.log(token);
}).catch((err) => {
    console.error(`token.sh: ${err.message}`);
    process.exit(1);
});'
