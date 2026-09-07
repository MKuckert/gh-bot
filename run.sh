#!/usr/bin/env bash
# run.sh — one bot round. Fail loud on missing credentials/config.
set -euo pipefail

cd "$(dirname "$0")"   # repo root

# Cron runs with a minimal PATH; make sure node is findable (fail loud if not).
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
if ! command -v node >/dev/null; then
    echo "run.sh: 'node' not found in PATH (need Node 22)" >&2
    exit 1
fi

# Never run two rounds at once (a slow LLM can outlive the hourly tick).
LOCK_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/overcommit-bot"
mkdir -p "$LOCK_DIR"
exec 9>"$LOCK_DIR/round.lock"
if ! flock -n 9; then
    echo "run.sh: previous round still running — skipping this tick" >&2
    exit 0
fi

# Credentials + key (fail loud, names the missing item); exports KEY_PATH.
source lib/env.sh

exec node src/bot.mjs "$@"
