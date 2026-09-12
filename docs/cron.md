# Using the cron-triggered bot (`run.sh`)

`run.sh` performs **one bot round**: list open issues → find the owner's latest
comment (the trigger) → run a headless pi agent in a fresh clone of the repo
(research or PR review, depending on the comment) → post the agent's output as
`overcommit-app [bot]`. Cron is the trigger; `run.sh` is fully self-contained
and safe to call from any context.

## Prerequisites (one-time)

1. A cron daemon **on the host** (outside the container) that starts each round
   with `docker exec` — see below. The round runs **as root inside the container**
   (it chowns each clone to the unprivileged agent user and drops privileges via
   `runuser`).
2. Credentials in place (already done): `.env` + `key.pem` at repo root, both gitignored.
3. The agent user — **self-healing**: each round checks that `botagent` and its
   pi config exist and runs `scripts/setup-agent-user.sh` (idempotent) if not, so
   a recreated container recovers on the next tick. It creates `botagent`, a
   private pi config at `/var/lib/overcommit/pi-agent` (model catalog + provider
   key for the local endpoint + the web-search package + a pi wrapper) — and
   nothing else on the machine is readable to it (`/home/node/.pi` is locked to
   700, so the live agent's sessions are out of reach). The script can also be
   run manually: `docker exec -u root gh-bot /workspace/gh-bot/scripts/setup-agent-user.sh`.
4. Model reachable — the `omlx` provider in `models.json` points at the local
   model server; no API key is needed beyond the endpoint's own.

## Installing the cron entry (on the host)

The container must have a **stable name** (`docker ps` shows it; substitute yours
for `gh-bot` below). Hourly, at the top of the hour, with a persistent log on the host:

```bash
mkdir -p /var/log/overcommit-bot   # cron cannot create the log's directory
```

```cron
0 * * * * docker exec -u root gh-bot /workspace/gh-bot/run.sh >> /var/log/overcommit-bot/cron.log 2>&1
```

Notes:
- `-u root` is required (chown + runuser). No TTY or shell flags needed.
- If the container is not running, `docker exec` fails and the error lands in
  `cron.log` — restart the container and the next tick recovers.
- The overlap lock lives inside the container, so it still works across
  `docker exec` invocations (and against manual runs inside the container).

Check it with `crontab -l` on the host. Remove the line to disable the bot —
there is no daemon or state to stop.

## What happens on each tick

1. `run.sh` sets PATH (incl. `/usr/sbin` for `runuser`), cd's to the repo root, sources `.env`.
2. Missing `GH_APP_ID`/`GH_INSTALLATION_ID`/`key.pem` → **exit 1** with a message naming the missing item (visible in `cron.log`).
3. **Overlap guard:** if a previous round still holds `/var/lib/overcommit-bot/round.lock`, this tick logs "previous round still running — skipping" and exits 0. (A 27B local run can outlive an hourly tick; the lock prevents double-posting.)
4. **Stale sweep:** workdirs in `/tmp/overcommit-*` untouched for 60+ minutes (left by a killed round) are removed.
5. **Self-heal:** if the `botagent` user or its pi config is missing (e.g. after a container recreation), `scripts/setup-agent-user.sh` runs first; a setup failure aborts the round with exit 1.
6. `node src/bot.mjs` runs the round; per triggered issue: clone (agent user's
   workdir) → `runuser -u botagent pi -p …` with a strict tool allowlist
   (research: `read,web_search,web_fetch`; review: `read`) → post.
7. Round summary is logged, e.g.:
   `[overcommit-bot] round done: 2 posted, 3 skipped, 0 failed`

## Exit codes and logs

| Outcome | Exit | Log evidence |
|---|---|---|
| Clean round | 0 | `round done: N posted, …` with no `ERROR` lines |
| Some issues failed (agent run failed, timeout) | 1 | `ERROR #<n>: <reason>` per issue; other issues still processed |
| Cannot even list issues (auth, network) | 1 | `ERROR: cannot list open issues: …` |
| Previous round still running | 0 | `previous round still running — skipping this tick` |
| Missing credentials | 1 | `env.sh: missing …` |
| Agent setup failed (self-heal) | 1 | `run.sh: agent setup failed` |

Log file: `/var/log/overcommit-bot/cron.log` (append-only; rotate as you see fit).

## Manual operation

```bash
# from inside the container — or: docker exec -u root gh-bot bash -lc 'cd /workspace/gh-bot && ./run.sh'
cd /workspace/gh-bot
./run.sh              # one real round (posts)
DRY_RUN=1 ./run.sh    # one dry round — prints the would-be prompts, posts nothing, clones nothing
```

Use `DRY_RUN=1` after credential or prompt changes — it is a fast config check
(no 27B runs, no network writes).

## Failure policy (by design)

- The bot **never posts placeholder or fabricated content** — if the agent run
  fails (non-zero exit, empty output, timeout), the issue is counted as failed
  and the round exits non-zero.
- Only comments authored by `BOT_OWNER` trigger anything; a last comment by any
  other account (human or bot) means the issue is skipped this round.
- One issue failing never stops the others, but the round still exits non-zero so cron's log shows it.
