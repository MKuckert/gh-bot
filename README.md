# overcommit-bot

A self-contained, cron-triggered GitHub bot that acts on **the repo owner's comments** in open issues of a target repository. It has two verticals, both powered by a **headless pi agent** running in a fresh clone of the repo as an unprivileged user:

| Vertical | Trigger (always the issue's **last** comment, and only if authored by the owner) | What happens |
|---|---|---|
| **Research** | last comment without a trigger phrase | The agent gets the issue + full thread, follows the owner's explicit instructions if there are any — otherwise researches (code + web) and posts its findings |
| **PR review** | comment containing `@overcommit-bot review` | Linked PRs (cross-references / Development section) are cloned at their head commit; the agent reviews diff + code and posts on **the PR**. Re-triggering re-reviews: the bot's previous review is fed back in so it reports which points are addressed |

## Security model

The bot reads public issue content that anyone can write — prompt injection is the
primary threat. Defense in depth:

1. **Author gate** — only comments authored by `BOT_OWNER` (default `mkuckert`)
   trigger anything. All other issue/PR content is *data*, never instructions; the
   system prompt tells the agent to ignore imperative text in untrusted content.
2. **Unprivileged agent user** — the pi agent runs as `botagent` (via `runuser`),
   a dedicated system user with no shell, no home and a private pi config. It can
   read only its fresh clone and public system files — never `/workspace`, the live
   agent's home (`/home/node/.pi` is locked 700), `.env` or `key.pem`. Even a fully
   injected agent has nothing to exfiltrate, and it runs with a minimal environment
   (no bot config at all).
3. **Strict tool allowlists** (`pi --tools`) — research: `read,web_search,web_fetch`;
   review: `read` only. No bash, no writes, ever; nothing from issue content is
   built, run or applied. The PR diff is computed orchestrator-side (our git code)
   and injected into the prompt.
4. **Explicit opt-in per issue** — an untouched issue is never touched; the owner
   must comment on it at least once.

## How a round works

1. `run.sh` (cron) → checks credentials, acquires an overlap lock, runs `node src/bot.mjs`.
2. List open issues of the target repo (`GH_REPO`, default `MKuckert/env`).
3. For each issue, fetch the **full** comment thread (paginated). No comments → skip.
   Last comment not by the owner → skip.
4. Research: clone the repo (main) → `runuser -u botagent pi -p …` with the research
   prompt + tool allowlist → post the agent's output on the issue.
5. Review: find linked PRs (timeline cross-references, open/merged) → clone each at
   `pull/N/head` (detached) → compute diff vs base → run the read-only review agent
   → post on the PR. No linked PRs → a short feedback comment on the issue.
6. Post as the app with the `🤖 **[overcommit-bot]**` marker; per-issue failures are
   logged and counted, the round exits non-zero if anything failed.

The bot never posts placeholder or fabricated content: a failed agent run (non-zero
exit, empty output, timeout) is counted as failed and nothing is posted for that issue.

## Layout

```
run.sh                     # cron entry point: env + overlap lock + node src/bot.mjs
lib/env.sh                 # shared bootstrap (cd root, load .env, fail loud)
scripts/setup-agent-user.sh# idempotent; run.sh runs it automatically if botagent/config is missing
key.pem                    # GitHub App private key (gitignored; never in .env)
.env                       # GH_APP_ID, GH_INSTALLATION_ID, BOT_OWNER, PI_*, AGENT_* (gitignored)
src/auth.mjs               # app JWT → installation token, cached until ~exp, 401 retry
src/github.mjs             # REST helpers: issues, comments (paginated), linked PRs, posting
src/git.mjs                # clone w/ askpass token indirection, PR head checkout, PR diff
src/pi.mjs                 # headless pi runner (runuser isolation, tool allowlist, timeout)
src/prompts.mjs            # template loading + prompt builders (research / review)
src/bot.mjs                # round orchestration + main block
prompts/system.md          # system-prompt addendum: posting rules + untrusted-content policy
prompts/bot_prompt.md      # research vertical prompt
prompts/review_prompt.md   # review vertical prompt (diff + previous review)
*.test.mjs                 # node --test suites (auth, bot, github, git, pi)
docs/token.md              # how to mint a temporary installation token (token.sh)
docs/cron.md               # installing/operating the cron entry
```

## Configuration (`.env`)

| Var | Meaning |
|---|---|
| `GH_APP_ID` / `GH_INSTALLATION_ID` | GitHub App + installation (required) |
| `BOT_OWNER` | login that may trigger the bot (default `mkuckert`) |
| `BOT_LOGIN` | the app's real GitHub login (default `overcommit-app[bot]`; finds its own comments) |
| `PI_PROVIDER` / `PI_MODEL` | pi model (default `omlx/qwen3.8-27B-oQ4e`, local endpoint) |
| `AGENT_USER` / `AGENT_HOME` | unprivileged agent user + its home (default `botagent` / `/var/lib/overcommit`) |
| `PI_BIN` | path to the pi binary (default `pi` on PATH) |
| `GH_REPO` | target repo override (default `MKuckert/env`) |

The model endpoint itself is configured in the agent's `models.json` (copied by
`setup-agent-user.sh`) — no model credentials in `.env`.

## Usage

```bash
# one-time (root): provision the unprivileged agent user + private pi config
scripts/setup-agent-user.sh

./run.sh              # one real round (posts comments)
DRY_RUN=1 ./run.sh    # dry round: prints would-be prompts, posts/clones/runs nothing

node --test           # unit tests (no network, no posting)
token.sh              # print a temporary installation token for manual git/gh work
```

Install the cron entry as described in [docs/cron.md](docs/cron.md) — host-side
schedule that starts each round with `docker exec -u root <container> /workspace/gh-bot/run.sh`.

## Design notes

- **Why the owner's *last* comment is the trigger:** it makes every owner comment an
  explicit assignment — a reply "pokes" the bot, and its output always responds to
  the freshest instruction. Non-owner activity (discussions, bot comments) never
  triggers anything. After the bot posts, the last comment is its own, so the round
  self-terminates — a failed run simply retries next hour until it succeeds.
- **Why `@overcommit-bot review` is a plain-text phrase:** GitHub App accounts cannot
  be @-mentioned, so the phrase is scanned in the owner's comment body.
- **Why pi instead of a raw model call:** the agent can navigate the checkout, run
  read-only inspection and use web search — with all of that confined to an
  unprivileged user and a strict tool allowlist.
- **Fail-loud everywhere:** missing credentials, failed clones, failed agent runs and
  posting errors are logged with the issue number; the round exits non-zero so cron's
  log shows it.

## Attribution

The source code of this bot was developed by a local **qwen3.8-27B** model
(`omlx/qwen3.8-27B-oQ4e`), driven through the pi coding agent — the same
harness the bot itself uses at runtime.
