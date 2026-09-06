# GitHub App Research — Replacing the PAT with a Dedicated Bot Identity

Research for **issue #100** ("gh Integration bot"). The periodic gh-integration-bot (reads open issues, posts research comments) currently runs under the owner's personal access token, so comments are authored by the human account `MKuckert` and identified only by a `🤖 **[gh-integration-bot]**` text marker. This document covers creating a GitHub App so the bot has its own identity and no longer needs the PAT.

> **Status (2026-09-06): implemented.** The bot runs in the sandbox on cron as `overcommit-bot [bot]` (app ID 4843934, installation 159479245); the first real round posted 6 comments. Ops: `gh-bot/README.md`, `gh-bot/docs/cron.md`. Remaining: revoke the old PAT (manual). Where this research doc and reality diverge, reality wins — see the corrections marked below.

## Summary

- **What to create:** a private, repo-only GitHub App (`gh-integration-bot`), installed on this single repo. It gets its own identity: comments are authored as `gh-integration-bot [bot]`.
- **Why it fixes identity:** app-authored comments are distinguishable in the UI, via `author.login` (REST/GraphQL), and in audit logs — the skip-check can switch from fragile text-marker matching to an author check (marker kept as fallback).
- **Auth model:** two-token chain, no PAT — a short-lived **JWT** (RS256-signed with the app's private key, ≤10 min) authenticates *as the app*; it mints an **installation access token** (≤1 h, 5000 req/h) which is used as `GITHUB_TOKEN` for all REST/`gh` calls.
- **Scheduling:** GitHub Actions `schedule: cron` workflow — private key lives in repo secrets, no egress setup, visible run history. Cron granularity is ≥5 min, which is fine for a periodic research bot. **(Superseded — final: cron in the sandbox; see note below.)**
- **Migration risk:** low. Bot logic (read issues → post comment) is unchanged; only the token source and the "is this a bot?" check change. The old PAT is revoked after the first verified `[bot]`-authored round.

## App Setup Steps

1. **Create the GitHub App.**
   `Settings → Developer settings → GitHub Apps → New GitHub App` (owner-level; only the owner can do this).
   - **GitHub App name:** `gh-integration-bot` (becomes the visible identity `gh-integration-bot [bot]`).
   - **Description:** "Posts periodic research comments on open issues."
   - **Event subscriptions:** none — a polling bot that posts comments needs no webhooks.
   - **Repository permissions (repo-only install):**

     | Permission       | Access        |
     |------------------|---------------|
     | Contents         | Read & write  |
     | Issues           | Read & write  |
     | Issue comments   | Write-only    |
     | Pull requests    | Read & write  |

     *(Table updated post-creation: Contents and Pull requests were widened to read & write so the installation token can also be used for git push.)*

   - **Webhook:** leave "Active" unchecked; no webhook secret needed.
   - Reference: <https://docs.github.com/en/apps/github-apps/creating-a-github-app>

2. **Generate the private key** on the app's *Settings* tab → **Private keys → Generate a private key**. Save the PEM file securely; it is shown only once. Note the **App ID** (numeric, on the main app page) — it is the `iss` claim of the JWT.

3. **Install the app on this repo.** App page → **Install App** → choose "Only select repositories" → tick `MKuckert/env`. The **installation ID** appears in the install URL (`/apps/<slug>/installations/<id>`) — it is the `GH_INSTALLATION_ID` used to mint tokens.

4. **Store credentials.** Originally specified as repo secrets (`GH_APP_ID`, `GH_PRIVATE_KEY`, `GH_INSTALLATION_ID`) for the Actions approach. **As built (local execution):** `GH_APP_ID` + `GH_INSTALLATION_ID` in the gitignored `.env` at repo root; PEM at `gh-bot/key.pem` (chmod 600).

## Auth Flow

1. **Mint a JWT** signed `RS256` with the app private key: payload `{ iss: <App ID>, iat: now, exp: now + ≤10 min }`. This authenticates *as the app itself* (no repo scope yet).
2. **Exchange for an installation token:** `POST /app/installations/{installation_id}/access_tokens` with the JWT → returns a token valid **≤1 h** for this repo. Cache and reuse it until ~5 min before expiry; re-mint on 401.
3. **Use it** as `GITHUB_TOKEN` for REST calls or the `gh` CLI. Comments posted with it are authored by `gh-integration-bot [bot]`.

References:
- <https://docs.github.com/en/apps/github-apps/authenticating-with-a-github-app> (creating a JWT, getting an installation token)
- <https://docs.github.com/en/rest/apps/apps?apiVersion=2022-11-28#create-an-installation-access-token-for-an-app>
- <https://docs.github.com/en/apps/github-apps/troubleshooting-your-github-app#jwt-expiration-errors>

### Minimal example (Node.js, `jsonwebtoken`)

```js
// bot-auth.mjs — mint app JWT + installation token
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";

const appId = process.env.GH_APP_ID;
const installationId = process.env.GH_INSTALLATION_ID;
const pem = readFileSync(process.env.GH_PRIVATE_KEY_FILE, "utf8");

// 1. App JWT (RS256, ≤10 min)
const appJwt = jwt.sign({}, pem, { algorithm: "RS256", issuer: appId, expiresIn: 540 }); // ≤ 10 min — 900 s is rejected

// 2. Installation token (≤1 h)
const res = await fetch(
  `https://api.github.com/app/installations/${installationId}/access_tokens`,
  { method: "POST", headers: { Authorization: `Bearer ${appJwt}`, Accept: "application/vnd.github+json" } },
);
const { token } = await res.json();

// 3. Use it: list open issues, check last comment author
const gh = { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } };
const issues = await (await fetch("https://api.github.com/repos/MKuckert/env/issues?state=open", gh)).json();
for (const issue of issues) {
  if (issue.pull_request) continue; // issues only
  const comments = await (await fetch(issue.comments_url, gh)).json();
  const last = comments.at(-1);
  if (last && last.user.login.endsWith("[bot]")) continue; // already handled by bot
  await fetch(issue.comments_url, { ...gh, method: "POST", body: JSON.stringify({ body: "🤖 **[gh-integration-bot]** — research comment" }) });
}
```

## Scheduling Recommendation

| Option | Pros | Cons |
|---|---|---|
| **(a) GitHub Actions `schedule: cron`** | Private key stays in repo secrets; runs on GitHub's network (no egress config); run history + logs for free; no sandbox dependency | Shared-minute cost on private repos (a few minutes per round); cron granularity ≥5 min; schedule pauses if the repo is archived |
| **(b) Local cron in the sandbox** | Sub-5-min granularity; no Actions minutes | Key must live in the sandbox (the exact risk being removed); no central logs; dies with the sandbox |

**Recommendation: (a).** A research bot that runs every 30–60 min costs negligible minutes and keeps the private key out of the sandbox entirely.

> **Superseded (2026-09-03):** the bot must run locally in the sandbox to reach the local LLM (omlx); GitHub infrastructure is off the table. Final plan: option (b) — local launchd scheduling in the sandbox, private key stored locally. See `PLAN.md`.
>
> **Superseded again (2026-09-06):** the sandbox has no launchd — final scheduling is **cron in the sandbox**, with `gh-bot/run.sh` as the self-contained target (operator installs the cron entry). See `gh-bot/docs/cron.md`.
> **The Actions workflow below is kept for reference only — it was never deployed.**
>
> **Verified (2026-09-06):** app created as `overcommit-bot` (ID 4843934, installation 159479245); JWT → installation token → issue read all work. Note: the string Client ID is **not** accepted as `iss` by this endpoint (401 "must be an Integer") despite the 2024-05 changelog — use the numeric App ID.

```yaml
# .github/workflows/gh-integration-bot.yml
name: gh-integration-bot
on:
  schedule: [{ cron: "0 * * * *" }]   # hourly; GitHub minimum granularity is 5 min
  workflow_dispatch: {}               # manual trigger for testing

jobs:
  bot-round:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install jsonwebtoken
      # Store the PEM as a file (multi-line secret → file) before running:
      - run: |
          printf '%s' "$GH_PRIVATE_KEY" > key.pem
          node bot.mjs   # GH_APP_ID / GH_INSTALLATION_ID / GH_PRIVATE_KEY_FILE from secrets/env
        env:
          GH_APP_ID: ${{ secrets.GH_APP_ID }}
          GH_INSTALLATION_ID: ${{ secrets.GH_INSTALLATION_ID }}
          GH_PRIVATE_KEY: ${{ secrets.GH_PRIVATE_KEY }}
          GH_PRIVATE_KEY_FILE: key.pem
```

Rate limits: installation tokens get **5000 requests/hour** — one round touches ~2 API calls per issue, far below the cap.

## Migration Checklist (final state, 2026-09-06)

- [x] Create the app + key; install on `MKuckert/env` — done as `overcommit-bot` (ID 4843934, installation 159479245); credentials in local `.env` + `gh-bot/key.pem` (not repo secrets — local execution).
- [x] Add the scheduler; test via manual trigger first — `gh-bot/run.sh` cron target + `DRY_RUN=1`; dry round verified (6 issues, 0 failed).
- [x] Switch the skip-check from marker-prefix matching to `author.login.endsWith("[bot]")` — done in `gh-bot/bot.mjs`; the text marker is kept as a human-readable fallback.
- [x] Verify the first automated round: 6 comments authored by `overcommit-bot [bot]` (UI + API), 2026-09-06.
- [ ] **Revoke the old personal PAT** (`Settings → Developer settings → Personal access tokens`) and remove any sandbox cron that used it — **still outstanding (manual, owner action)**.
- [x] Note the app's location + key-regeneration procedure in the ops runbook — `gh-bot/README.md`.
