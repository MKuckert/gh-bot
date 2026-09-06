# Using `gh-bot/token.sh` — temporary GitHub tokens for other sessions

`token.sh` mints a **GitHub App installation token** (valid ≤ 1 h, 5000
requests/h) for this repo's app installation and prints it to stdout. It is
how other agent sessions in this sandbox get GitHub access **without** the
private key or a personal PAT: the script reads `gh-bot/key.pem` itself, signs
the app JWT, and exchanges it for the installation token.

## Output contract

- **stdout:** exactly one line — the token (`ghs_…`).
- **stderr:** expiry timestamp (`token.sh: valid until <ISO8601>`) and any diagnostics.

This split is deliberate so shell capture stays clean:

```bash
TOK=$(gh-bot/token.sh)        # captures the token only
```

## Typical use in a session

```bash
cd /workspace/env-gh-app
export GITHUB_TOKEN=$(gh-bot/token.sh)

git push ...                          # repo's credential helper reads $GITHUB_TOKEN
gh issue list --repo MKuckert/env     # the gh CLI reads $GITHUB_TOKEN too
curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/rate_limit
```

The token acts as `overcommit-bot [bot]` with the app's installation
permissions (contents, issues, issue comments, pull requests).

## Lifetime and re-minting

- Tokens expire within the hour — check the stderr line for the exact time.
- **Long-running sessions: re-mint, don't cache.** If a push/`gh` call returns
  401, run `export GITHUB_TOKEN=$(gh-bot/token.sh)` again.
- Each invocation mints a fresh token; unused ones simply expire.

## Failure modes (fail loud)

| Symptom | Cause |
|---|---|
| `token.sh: missing env var(s): GH_APP_ID …` (exit 1) | `.env` absent or incomplete at repo root |
| `token.sh: missing gh-bot/key.pem` (exit 1) | private key not in place |
| `token.sh: token mint failed (HTTP 401): …` (exit 1) | key/ID mismatch, clock skew, or GitHub rejecting the JWT — read the body |

## Security notes

- The token is **ephemeral by design**: keep it in a shell variable. Never write
  it to a file, commit it, or echo it into logs.
- It grants the app's repo permissions — treat it like a credential, not a key.
- The private key never leaves `gh-bot/key.pem`; only the script touches it.
- To kill access immediately, delete/regenerate the app's private key in GitHub
  (see `gh-bot/README.md` → Operations).
