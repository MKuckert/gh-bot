# gh-bot — overcommit-bot runbook

Periodic research bot (standalone): reads open issues from a target repo
(default `MKuckert/env`, override with `GH_REPO`), generates a research comment
with the local LLM (OpenAI-compatible model API), posts it as `overcommit-bot [bot]`
via a GitHub App installation token. Runs **locally in the sandbox** — that is
the point, so it can reach the local model. No dependency on any other repository.

## Layout

| File | Purpose |
|---|---|
| `src/auth.mjs` | GitHub App auth via `@octokit/auth-app` — JWT, token mint/cache, 401 handling |
| `src/github.mjs` | Thin REST helpers on Octokit (list issues, comments, post) |
| `src/llm.mjs` | model client (`/v1/chat/completions`, OpenAI-compatible), prompt builder |
| `prompts/bot_prompt.md` | user-prompt template (edit to change the comment style) |
| `prompts/system.md` | system prompt sent with every request |
| `src/bot.mjs` | One round: skip-check → LLM → post. `DRY_RUN=1` prints instead of posting |
| `run.sh` | **The cron target.** Loads `.env`, checks credentials, flock guard, runs one round |
| `token.sh` | Prints a fresh installation token (≤ 1 h) to stdout — for git/gh in other sessions |
| `lib/env.sh` | Shared bootstrap for the shell entry points: loads `.env`, checks credentials, exports `KEY_PATH` |
| `src/verify-auth.mjs` | Live end-to-end auth check (app metadata, token mint, issue read) |
| `src/*.test.mjs` | Unit tests — `node --test` at the repo root |
| `docs/cron.md`, `docs/token.md` | Usage guides for the cron target and token minting |
| `plans/2026-09-07-initial.md` | Archived original plan |

## Credentials (all gitignored)

- `.env` at repo root: `GH_APP_ID`, `GH_INSTALLATION_ID`, `MODEL_BASE_URL`, `MODEL_NAME`, `MODEL_API_KEY`
- `key.pem` at repo root: app private key (chmod 600)
- model API key: `MODEL_API_KEY` in `.env` (standalone — no external settings file needed)

## Scheduling (cron)

Hourly cron entry, overlap guard, exit codes and manual operation:
**[`docs/cron.md`](docs/cron.md)**.

## Tokens for other sessions

`token.sh` mints an ephemeral installation token (≤ 1 h) for git/gh in other
sessions — output contract, re-minting and security notes:
**[`docs/token.md`](docs/token.md)**.

## Operations

```bash
cd /workspace/gh-bot
node --test            # unit tests
./run.sh               # one real round (posts)
DRY_RUN=1 ./run.sh     # one dry round (prints, no posts)
node src/verify-auth.mjs   # live auth-chain check, no side effects
```

- **Logs:** `~/.local/state/overcommit-bot/cron.log` (cron) — round summary lines start with `[overcommit-bot]`.
- **Skip logic:** an issue is skipped when its *last* comment's author login ends with `[bot]` (any bot). The posted marker `🤖 **[overcommit-bot]**` is a human-readable fallback, not the skip mechanism.
- **Disable:** remove the cron line. Nothing else to stop (no daemon).
- **Key regeneration:** GitHub App settings → Private keys → Generate; replace `key.pem` (chmod 600). Old key stays valid until deleted.
- **Rate limits:** installation tokens get 5000 req/h; one round is ~2 calls per issue.

## Failure policy (fail loud, never fake)

- Missing credentials → non-zero exit, message names the missing item.
- model unreachable / non-2xx → issue counted as failed, round exits non-zero; **no** placeholder comment is ever posted.
- GitHub 401 → one retry (token replication delay, within 5 s of mint); a persistent 401 or an expired token aborts the round (tokens re-mint on expiry).
- One issue failing never stops the others, but the round still exits non-zero.
