#!/usr/bin/env bash
# run.sh — one bot round. Fail loud on missing credentials/config.
set -euo pipefail

cd "$(dirname "$0")"   # repo root

# Cron runs with a minimal PATH; make sure node is findable (fail loud if not).
# runuser is needed to drop the agent to its unprivileged user.
export PATH="/usr/local/bin:/usr/sbin:/sbin:/usr/bin:/bin:$PATH"
if ! command -v node >/dev/null; then
    echo "run.sh: 'node' not found in PATH (need Node 22)" >&2
    exit 1
fi

# Never run two rounds at once (a slow agent run can outlive the hourly tick).
# Fixed path so manual and cron runs share one lock (fall back to $HOME when
# the fixed dir is not writable, e.g. unprivileged development).
LOCK_DIR="/var/lib/overcommit-bot"
mkdir -p "$LOCK_DIR" 2>/dev/null || {
    LOCK_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/overcommit-bot"
    mkdir -p "$LOCK_DIR"
}
exec 9>"$LOCK_DIR/round.lock"
if ! flock -n 9; then
    echo "run.sh: previous round still running — skipping this tick" >&2
    exit 0
fi

# Sweep workdirs left by a round that died (hard kill / OOM): we hold the lock,
# so anything here belongs to a dead round. The 60-min age guard protects
# concurrent unprivileged dev runs, which fall back to a per-user lock.
stale=$(find /tmp -maxdepth 1 -name 'overcommit-*' -type d -mmin +60 2>/dev/null || true)
if [[ -n "$stale" ]]; then
    echo "$stale" | xargs -r rm -rf
    echo "run.sh: removed stale workdir(s) from a dead round" >&2
fi

# Credentials + key (fail loud, names the missing item); exports KEY_PATH.
source lib/env.sh

# Self-heal: if the unprivileged agent user or its pi config is missing (e.g.
# after a container recreation), provision it now. setup-agent-user.sh is
# idempotent; this runs as root under docker exec -u root.
AGENT_USER="${AGENT_USER:-botagent}"
AGENT_HOME="/var/lib/overcommit"   # must match setup-agent-user.sh and src/pi.mjs
need_setup=0
if ! id "$AGENT_USER" >/dev/null 2>&1; then
    need_setup=1
elif [[ ! -f "$AGENT_HOME/pi-agent/models.json" || ! -x "$AGENT_HOME/pi-agent/bin/pi" ]]; then
    need_setup=1
fi
if [[ $need_setup -eq 1 ]]; then
    if [[ ${EUID} -ne 0 ]]; then
        echo "run.sh: agent user '$AGENT_USER' not provisioned and we are not root — agent runs will fail" >&2
    else
        echo "run.sh: agent user/config missing — running setup-agent-user.sh" >&2
        ./scripts/setup-agent-user.sh || { echo "run.sh: agent setup failed" >&2; exit 1; }
    fi
fi

exec node src/bot.mjs "$@"
