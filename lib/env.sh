# lib/env.sh — shared bootstrap for the shell entry points (run.sh, token.sh).
# Source it from a repo-root script; on success you are at the repo root with:
#   GH_APP_ID, GH_INSTALLATION_ID, BOT_OWNER, PI_*, AGENT_*  loaded from .env (if present)
#   KEY_PATH                       absolute path to the app private key
# Missing pieces fail loud: exit 1 with a message naming the item.

_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$_repo_root"

# Cron/launchd contexts have no direnv; load local credentials explicitly.
if [[ -f .env ]]; then
    set -a; source ./.env; set +a
fi

missing=()
for v in GH_APP_ID GH_INSTALLATION_ID; do
    [[ -n "${!v:-}" ]] || missing+=("$v")
done
if (( ${#missing[@]} )); then
    echo "env.sh: missing env var(s): ${missing[*]} — expected in .env at repo root" >&2
    exit 1
fi

export KEY_PATH="$_repo_root/key.pem"
if [[ ! -f "$KEY_PATH" ]]; then
    echo "env.sh: missing key.pem (app private key)" >&2
    exit 1
fi

unset _repo_root
