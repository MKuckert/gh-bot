# Using `token.sh` — temporary GitHub tokens for other sessions

`token.sh` mints a **GitHub App installation token** (valid ≤ 1 h, 5000
requests/h) for this repo's app installation and prints it to stdout. It is
how other agent sessions in this sandbox get GitHub access **without** the
private key or a personal PAT: the script loads credentials via `lib/env.sh`
and mints through `src/auth.mjs --token` (JWT signed with `key.pem`,
exchanged for the installation token).

## Output contract

- **stdout:** exactly one line — the token (`ghs_…`).
- **stderr:** expiry timestamp (`auth: valid until <ISO8601>`) and any diagnostics.

This split is deliberate so shell capture stays clean:

```bash
TOK=$(token.sh)               # captures the token only
```

## Typical use in a session

```bash
cd /workspace/gh-bot
export GITHUB_TOKEN=$(token.sh)

gh issue list --repo MKuckert/env     # the gh CLI reads $GITHUB_TOKEN
curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/rate_limit
```

The token acts as `overcommit-bot [bot]` with the app's installation
permissions (contents, issues, issue comments, pull requests).

## Raw `git` commands

The API and the `gh` CLI accept the token as a Bearer header or `$GITHUB_TOKEN`,
but **git's smart-HTTP protocol does not**: `http.extraHeader="Authorization:
Bearer …"` fails with `remote: invalid credentials`. Git needs Basic auth, so
feed the token through an askpass helper — it never lands in argv or a URL:

```bash
export GITHUB_TOKEN=$(token.sh)
printf '#!/bin/sh\necho "$GITHUB_TOKEN"\n' > .askpass.sh && chmod +x .askpass.sh
export GIT_ASKPASS=$PWD/.askpass.sh
git -c credential.helper= push origin main
rm .askpass.sh
```

(`-c credential.helper=` disables stored helpers so the token stays in this
shell only. Alternatively, configure a credential helper that reads
`$GITHUB_TOKEN`, after which a plain `git push` works.)

> **Warning — do not pre-check push permission via the REST API.**
> `gh api repos/<owner>/<repo> -q .permissions` (or the repo object's
> `permissions` field) reports **all false** for repos that a minted
> installation token can actually push to. In this setup, that check said
> `"push":false` for `MKuckert/gh-bot` while the askpass push above
> succeeded. Do not conclude "no access" from that endpoint — and do not
> fall back to asking the user for a PAT on its basis. The only reliable
> test is attempting the push (or an API write) with the token.
>
> Related: `GET /app/installations` lists one installation per *account*
> (here a single entry for `MKuckert`), not one per repo — the same
> installation covers multiple repos of that account. Do not infer which
> repos it can write to from the list length.

## Lifetime and re-minting

- Tokens expire within the hour — check the stderr line for the exact time.
- **Long-running sessions: re-mint, don't cache.** If a push/`gh` call returns
  401, run `export GITHUB_TOKEN=$(token.sh)` again.
- Each invocation mints a fresh token; unused ones simply expire.

## Failure modes (fail loud)

| Symptom | Cause |
|---|---|
| `env.sh: missing env var(s): GH_APP_ID …` (exit 1) | `.env` absent or incomplete at repo root |
| `env.sh: missing key.pem` (exit 1) | private key not in place |
| octokit `HttpError` / 401 on mint (exit 1) | key/ID mismatch, clock skew, or GitHub rejecting the JWT — read the message body |
| `git push` → `remote: invalid credentials` | token used as Bearer header instead of Basic auth — use the askpass recipe above, not `http.extraHeader` |
| API says no permission but push works (or vice versa) | see the warning above — trust the actual operation, not `permissions` fields |

## Security notes

- The token is **ephemeral by design**: keep it in a shell variable. Never write
  it to a file, commit it, or echo it into logs.
- It grants the app's repo permissions — treat it like a credential, not a key.
- The private key never leaves `key.pem` at the repo root; only the script touches it.
- To kill access immediately, delete/regenerate the app's private key in GitHub
  (see `README.md` → Operations).
