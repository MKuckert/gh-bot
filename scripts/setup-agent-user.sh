#!/usr/bin/env bash
# setup-agent-user.sh — one-time, idempotent setup of the unprivileged user the
# pi agent runs as, plus its private config dir. The agent can read only what
# this user can: the fresh clone (chowned per run) and public system files —
# never /workspace, node's home, or any credential.
#
# Usage (as root):  scripts/setup-agent-user.sh [source-models.json]
set -euo pipefail

AGENT_USER="${AGENT_USER:-botagent}"
AGENT_HOME="${AGENT_HOME:-/var/lib/overcommit}"
SRC_MODELS="${1:-/home/node/.pi/agent/models.json}"

if [[ $EUID -ne 0 ]]; then
    echo "setup-agent-user: must run as root" >&2
    exit 1
fi

id "$AGENT_USER" &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin "$AGENT_USER"
mkdir -p "$AGENT_HOME/pi-agent/npm/node_modules/@bytetrue"
cp "$SRC_MODELS" "$AGENT_HOME/pi-agent/models.json"
# pi also needs provider auth; keep only the entry for the provider we use.
SRC_AUTH="$(dirname "$SRC_MODELS")/auth.json"
if [[ -f "$SRC_AUTH" ]]; then
    node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const p=process.argv[2];fs.writeFileSync(process.argv[3],JSON.stringify(a[p]?{[p]:a[p]}:{},null,2))' "$SRC_AUTH" "${PI_PROVIDER:-omlx}" "$AGENT_HOME/pi-agent/auth.json"
fi
# web_search/web_fetch for the research vertical: copy just that package + its
# (single) dependency, and a minimal settings.json that loads only it.
SRC_NPM="$(dirname "$SRC_MODELS")/npm/node_modules"
cp -r "$SRC_NPM/@bytetrue/pi-web-search" "$AGENT_HOME/pi-agent/npm/node_modules/@bytetrue/"
cp -r "$SRC_NPM/undici" "$AGENT_HOME/pi-agent/npm/node_modules/"
cat > "$AGENT_HOME/pi-agent/settings.json" <<'EOF'
{
  "packages": [
    "npm:@bytetrue/pi-web-search"
  ]
}
EOF
# pi itself: the live install's bin is a symlink into the world-readable global
# tree — wrap it so the agent never needs to traverse /home/node/.pi (700).
PI_JS="$(readlink -f "${PI_BIN_SOURCE:-/home/node/.pi/agent/bin/pi}")"
mkdir -p "$AGENT_HOME/pi-agent/bin"
cat > "$AGENT_HOME/pi-agent/bin/pi" <<EOF
#!/bin/sh
exec node $PI_JS "\$@"
EOF
chmod 755 "$AGENT_HOME/pi-agent/bin/pi"
chown -R "$AGENT_USER:$AGENT_USER" "$AGENT_HOME"
chmod 700 "$AGENT_HOME"

echo "setup-agent-user: $AGENT_USER ready; config at $AGENT_HOME/pi-agent (models from $SRC_MODELS)"
echo "setup-agent-user: verify with:  runuser -u $AGENT_USER -- env HOME=$AGENT_HOME PI_CODING_AGENT_DIR=$AGENT_HOME/pi-agent $AGENT_HOME/pi-agent/bin/pi --version"
