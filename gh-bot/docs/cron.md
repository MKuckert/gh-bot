# Using the cron-triggered bot (`gh-bot/run.sh`)

`run.sh` performs **one bot round**: list open issues → skip those already
handled by a bot → generate a research comment with the local LLM (omlx) →
post it as `overcommit-bot [bot]`. Cron is the trigger; `run.sh` is fully
self-contained and safe to call from any context.

## Prerequisites (one-time)

1. A cron daemon in the sandbox (the operator installs it; this container had none).
2. Credentials in place (already done): `.env` at repo root + `gh-bot/key.pem`, both gitignored.
3. omlx reachable — `OMLX_BASE_URL` in `.env` points at the LLM server as seen from this sandbox.

## Installing the cron entry

Hourly, at the top of the hour, with a persistent log:

```cron
0 * * * * /workspace/env-gh-app/gh-bot/run.sh >> /home/node/.local/state/overcommit-bot/cron.log 2>&1
```

Check it with `crontab -l`. Remove the line to disable the bot — there is no
daemon or state to stop.

## What happens on each tick

1. `run.sh` sets PATH, cd's to the repo root, sources `.env`.
2. Missing `GH_APP_ID`/`GH_INSTALLATION_ID`/`key.pem` → **exit 1** with a message naming the missing item (visible in `cron.log`).
3. **Overlap guard:** if a previous round still holds `~/.local/state/overcommit-bot/round.lock`, this tick logs "previous round still running — skipping" and exits 0. (A slow LLM can outlive an hourly tick; the lock prevents double-posting.)
4. `node gh-bot/bot.mjs` runs the round; one LLM call per unhandled issue.
5. Round summary is logged, e.g.:
   `[overcommit-bot] round done: 6 posted, 0 skipped, 0 failed`

## Exit codes and logs

| Outcome | Exit | Log evidence |
|---|---|---|
| Clean round | 0 | `round done: N posted, …` with no `ERROR` lines |
| Some issues failed (LLM down, API error) | 1 | `ERROR #<n>: <reason>` per issue; other issues still processed |
| Cannot even list issues (auth, network) | 1 | `ERROR: cannot list open issues: …` |
| Previous round still running | 0 | `previous round still running — skipping this tick` |
| Missing credentials | 1 | `run.sh: missing …` |

Log file: `/home/node/.local/state/overcommit-bot/cron.log` (append-only; rotate as you see fit).

## Manual operation

```bash
cd /workspace/env-gh-app
./gh-bot/run.sh              # one real round (posts)
DRY_RUN=1 ./gh-bot/run.sh    # one dry round — prints would-be comments, posts nothing
```

Use `DRY_RUN=1` after credential changes or before a known-bad LLM state.

## Failure policy (by design)

- The bot **never posts placeholder or fabricated content** — if omlx fails, the issue is counted as failed and the round exits non-zero.
- An issue whose *last* comment was authored by any `*[bot]` account is skipped (author check; the `🤖 **[overcommit-bot]**` marker in bodies is a human-readable fallback only).
- One issue failing never stops the others, but the round still exits non-zero so cron's log shows it.
