// git.mjs — clone the target repo (or a PR head) with an ephemeral installation
// token, and compute PR diffs orchestrator-side (the review agent has no bash).
// The token is fed to git through GIT_ASKPASS via an env var — it never lands
// in argv, a URL or the askpass file itself (see docs/token.md).

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run a git command in `dir`, resolve with stdout (fail loud). */
export async function git(dir, args, execImpl = execFile) {
  return new Promise((resolve, reject) => {
    execImpl("git", ["-C", dir, ...args], {}, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed in ${dir}: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

/**
 * Clone `repo` into a fresh temp dir. With `prNumber`, additionally fetch the
 * PR head (`refs/pull/N/head`) and check it out detached, so the agent works
 * on the exact PR commit with the base branch available for diffs.
 *
 * @param {object} opts
 * @param {string}        opts.repo      `owner/name`
 * @param {string}        opts.token     installation token (Basic auth via askpass)
 * @param {number|null}   [opts.prNumber]  PR to check out at its head commit
 * @param {Function}      [opts.execImpl]  injectable execFile (tests)
 * @returns {Promise<{dir: string, cleanup: () => void}>}
 */
export async function cloneForBot({ repo, token, prNumber = null, execImpl = execFile }) {
  if (!token) throw new Error("git: no token provided for clone");
  const dir = mkdtempSync(join(tmpdir(), "overcommit-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const askpass = join(dir, ".askpass.sh");
  // Env-var indirection: the token itself is not written to disk.
  writeFileSync(askpass, "#!/bin/sh\necho \"$GIT_BOT_TOKEN\"\n", { mode: 0o700 });
  const env = { ...process.env, GIT_ASKPASS: askpass, GIT_BOT_TOKEN: token, GIT_TERMINAL_PROMPT: "0" };
  try {
    await new Promise((resolve, reject) => {
      execImpl("git", ["-c", "credential.helper=", "clone", "--quiet", `https://github.com/${repo}.git`, dir], { env },
        (err, _stdout, stderr) => (err ? reject(new Error(`git clone failed: ${(stderr || err.message).trim()}`)) : resolve()));
    });
    if (prNumber != null) {
      await new Promise((resolve, reject) => {
        execImpl("git", ["-c", "credential.helper=", "-C", dir, "fetch", "--quiet", "origin", `pull/${prNumber}/head`], { env },
          (err, _stdout, stderr) => (err ? reject(new Error(`git fetch pull/${prNumber}/head failed: ${(stderr || err.message).trim()}`)) : resolve()));
      });
      await git(dir, ["checkout", "--quiet", "FETCH_HEAD"], execImpl);
    }
    return { dir, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Compute the PR diff for the review prompt (orchestrator-side git): commit
 * list, stat and full diff (capped). The review agent gets no bash, so this
 * is its window onto the changes; it reads files directly for context.
 */
export async function getPrDiff({ dir, baseRef, maxChars = 60_000, execImpl = execFile }) {
  // The PR's base branch may have been deleted (common after merge) — fall
  // back to the default branch and say so in the prompt.
  let base = baseRef ? `origin/${baseRef}` : null;
  if (base) {
    try { await git(dir, ["rev-parse", "--verify", base], execImpl); }
    catch { base = null; }
  }
  let baseNote = "";
  if (!base) {
    base = "origin/HEAD";
    if (baseRef) baseNote = `Note: base branch "${baseRef}" was not in the clone — diffed against the default branch instead.`;
  }
  const [log, stat, full] = await Promise.all([
    git(dir, ["log", "--oneline", `${base}..HEAD`], execImpl),
    git(dir, ["diff", "--stat", `${base}...HEAD`], execImpl),
    git(dir, ["diff", `${base}...HEAD`], execImpl),
  ]);
  let diff = full;
  let truncated = false;
  if (diff.length > maxChars) {
    diff = diff.slice(0, maxChars);
    truncated = true;
  }
  return { log: log.trim(), stat: stat.trim(), diff, truncated, baseNote };
}
