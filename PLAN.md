# PLAN: gh-integration-bot with GitHub App identity (issue #100)

**Refinement 2026-09-03:** Scheduling moves from GitHub Actions to **local execution in the sandbox** — hard requirement: the bot must reach the local LLM (omlx), which is unreachable from GitHub infrastructure. The research doc's recommendation of option (a) is superseded; its auth model, app setup, and identity checks carry over unchanged.

## Goal

Replace the PAT-based periodic research bot with a bot that:

1. Runs **locally in the sandbox** on the workstation (macOS), where it can call omlx (`http://localhost:11437`, OpenAI-compatible).
2. Authenticates to GitHub as a dedicated **GitHub App** (`overcommit-bot [bot]` — app name "Overcommit [bot]", slug `overcommit-bot`), eliminating the personal PAT.
3. Posts LLM-generated research comments on open issues, hourly.

## Architecture

```
cron (hourly) → gh-bot/run.sh   ← the cron target
                    ├─ auth.mjs     JWT (RS256, 540 s) → installation token (≤1 h, cached)
                    ├─ llm.mjs      POST {OMLX_BASE_URL}/chat/completions (omlx)
                    └─ bot.mjs      REST: list open issues → skip-check → LLM research → post comment
```

- **Code location:** new `gh-bot/` directory: `bot.mjs`, `auth.mjs`, `llm.mjs`, `run.sh`, `com.mkuckert.gh-integration-bot.plist` (launchd template), `README.md`.
- **Runtime:** Node 22 (present in sandbox). Only dependency: `jsonwebtoken` for the RS256 JWT.
- **Scheduling:** **cron** in the sandbox (operator installs the line; `gh-bot/run.sh` is the self-contained target: PATH fix, `.env` load, credential check, flock overlap guard). This container has no cron daemon yet — the operator adds it. `run.sh` is portable: on the macOS workstation the same target works under launchd/cron unchanged.
- **Logs:** cron appends to `~/.local/state/overcommit-bot/cron.log` — visible run history, fail-loud.

## Secrets (local, gitignored)

| Item | Location | Notes |
|---|---|---|
| `GH_APP_ID`, `GH_INSTALLATION_ID` | `.env` at repo root | already gitignored; loaded via direnv (`load_dotenv = true`) |
| Private key PEM | `gh-bot/key.pem` (gitignored, `chmod 600`) | shown once at generation; never committed |
| omlx API key | read from the omlx settings file (`OMLX_SETTINGS_FILE`, default `omlx/settings.json` → `auth.api_key`) | no new secret |
| omlx endpoint | `.env`: `OMLX_BASE_URL=http://192.168.178.61:11437/v1` (as seen from this sandbox; workstation default is `localhost:11437`) | env var, not a secret |

**Fail-loud rule:** if any credential is missing, `run.sh` prints an explicit error naming the missing item and exits non-zero. No silent skip, no placeholder output.

## Auth Flow (verified live 2026-09-06)

1. Mint JWT `{ iss: GH_APP_ID, iat, exp: now+540s }` signed RS256 with `key.pem`. **exp must be ≤ 10 min** — GitHub rejects 900 s ("too far in the future"); use 540 s.
2. `POST /app/installations/{GH_INSTALLATION_ID}/access_tokens` → installation token; cache until ~5 min before expiry, re-mint on 401.
3. Use as `Authorization: Bearer <token>` for all REST calls. Installation tokens cannot call `/user` (403 by design) — identity check goes via comment `author.login`.

**Client ID as `iss`: rejected.** The 2024-05 changelog says the Client ID may replace the App ID, but the live endpoint returns 401 `"'Issuer' claim ('iss') must be an Integer"` for the string client ID. Decision: use the numeric App ID (not deprecated).

## Bot Round Logic

1. `GET /repos/MKuckert/env/issues?state=open` (filter out `pull_request` entries).
2. For each issue: fetch comments; if the last comment's `user.login` ends with `[bot]`, skip (author check primary; keep the `🤖 **[gh-integration-bot]**` text marker in posted bodies as human-readable fallback).
3. Build a prompt from the issue (title, body, recent comments), call omlx `/v1/chat/completions` for the research comment.
4. `POST` the comment with marker prefix + LLM output.

### Failure handling (per fail-loud policy)

- **omlx unreachable / non-2xx:** log the error, skip that issue (or the round if the endpoint is down), exit non-zero. Never post a fabricated or placeholder comment.
- **GitHub 401:** re-mint the installation token once; on second 401 abort the round with a clear error.
- **Rate limit (403/429):** log `X-RateLimit-Reset`, abort round. 5000 req/h cap is far above usage (~2 calls/issue).
- **Partial round:** each issue is independent; a failure on one does not stop the others, but the round still exits non-zero so launchd logs it.

## Milestones

1. **App setup (manual, owner action) — DONE 2026-09-06.** App `overcommit-bot` (ID 4843934) created, installed on `MKuckert/env` (installation 159479245). Verified live: JWT mint → installation token → `GET /repos/MKuckert/env/issues` returns open issues. Credentials in place: `.env` (`GH_APP_ID`, `GH_INSTALLATION_ID`), `gh-bot/key.pem` (chmod 600); both gitignored.
2. **M1 — Auth module:** `auth.mjs` (JWT mint + installation token with caching and 401 re-mint) + unit test with a mock keypair asserting token shape/expiry and cache behavior.
3. **M2 — LLM module:** `llm.mjs` (omlx client: prompt build, request, error surfacing) + test against a stubbed HTTP server covering success and failure paths.
4. **M3 — Bot round:** `bot.mjs` (issue iteration, skip-check, comment posting) + `run.sh`; integration test in dry-run mode (`DRY_RUN=1` prints instead of posting).
5. **M4 — Scheduling + ops (DONE 2026-09-06):** `run.sh` hardened as the cron target (PATH, flock overlap guard, fail-loud credential check); exact cron line + ops runbook in `gh-bot/README.md`. Operator installs the cron entry.
6. **M5 — Cutover:** run one verified round with comments authored by `overcommit-bot [bot]` (check UI + API), then **revoke the old PAT** and remove its sandbox cron.
7. Update `PROJECT_MAP.md`/README; archive this plan to `docs/plans/YYYY-MM-DD_gh-integration-bot.md`.

## Acceptance Criteria

- Comments on open issues are authored by `overcommit-bot [bot]`, no PAT anywhere in the repo or sandbox env.
- A round works end-to-end from launchd trigger using only local omlx for content generation.
- Missing credentials, dead omlx, and 401s each produce a visible, logged failure (non-zero exit) — never silent or fake output.
- Old PAT revoked after first verified round.

## Open Decisions (flagged, defaults chosen)

- **Scheduler:** cron in the sandbox (operator-provided); `run.sh` is the portable target.
- **Interval:** hourly (matches prior cadence; omlx `max_concurrent_requests: 1` makes spacing sensible).
