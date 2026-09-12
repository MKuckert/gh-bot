// bot.mjs — one round: open issues → owner trigger check → vertical → post.
//
// Verticals (content is produced by a headless pi agent in a fresh clone, run
// as an unprivileged user with a strict tool allowlist — the bot only
// orchestrates: trigger detection, cloning, diffing, posting):
//   research — last comment by the owner (any comment): agent answers the
//              owner's explicit instructions, or researches and posts findings.
//   review   — last comment by the owner containing `@overcommit-bot review`:
//              linked PRs are cloned at their head commit and reviewed; the
//              bot's previous review is fed back in so re-reviews verify which
//              points were addressed.
//
// Security: only the owner's comments trigger anything; all other issue/PR
// content is untrusted data (see prompts/system.md). No label scoping.
//
// Fail-loud: per-issue errors are logged and counted; the round exits non-zero
// if anything failed. DRY_RUN=1 prints prompts instead of cloning, running
// agents or posting.

import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createGitHubOctokit } from "./auth.mjs";
import { GitHub } from "./github.mjs";
import { runPiAgent } from "./pi.mjs";
import { cloneForBot, getPrDiff } from "./git.mjs";
import { buildResearchPrompt, buildReviewPrompt, loadSystemAddendum } from "./prompts.mjs";

export const MARKER = "🤖 **[overcommit-bot]**";
export const REVIEW_TRIGGER = "@overcommit-bot review";

/** Strict tool allowlists — no bash, no writes, in either vertical. */
export const RESEARCH_TOOLS = ["read", "web_search", "web_fetch"];
export const REVIEW_TOOLS = ["read"];

/**
 * Run one bot round.
 * @param {object} deps
 * @param {import("./github.mjs").GitHub} [deps.github]
 * @param {(opts: object) => Promise<string>}  [deps.runAgent]  headless agent (pi)
 * @param {(opts: object) => Promise<{dir, cleanup}>} [deps.clone]  repo clone
 * @param {(opts: object) => Promise<object>}  [deps.prDiff]    PR diff computation
 * @param {() => Promise<string>} [deps.getToken]  installation token for clones
 * @param {string}   [deps.owner]    login that may trigger the bot (default $BOT_OWNER or "mkuckert")
 * @param {boolean}  [deps.dryRun]   print prompts instead of cloning/running/posting
 * @param {(msg: string) => void}    [deps.log]
 * @returns {Promise<{processed: number, skipped: number, failed: number}>}
 */
export async function runRound({ github, runAgent = runPiAgent, clone = cloneForBot, prDiff = getPrDiff, getToken, owner = process.env.BOT_OWNER ?? "mkuckert", dryRun = false, log = console.log } = {}) {
  if (!github) throw new Error("runRound: no github client provided");
  const stats = { processed: 0, skipped: 0, failed: 0 };
  // Lazy: only minted when a vertical actually clones.
  const getTokenFn = dryRun ? null : (getToken ?? (async () => (await github.octokit.auth()).token));

  let issues;
  try {
    issues = await github.listOpenIssues();
  } catch (err) {
    log(`ERROR: cannot list open issues: ${err.message}`);
    return { ...stats, failed: 1 };
  }
  log(`round start: ${issues.length} open issue(s)${dryRun ? " [DRY_RUN]" : ""}`);

  for (const issue of issues) {
    try {
      const comments = await github.getComments(issue);
      const last = comments.at(-1);
      if (!last) {
        stats.skipped++;
        log(`#${issue.number} skip — no comments yet (owner must comment once to activate)`);
        continue;
      }
      if (last.user?.login !== owner) {
        stats.skipped++;
        log(`#${issue.number} skip — last comment by ${last.user?.login ?? "?"}, not owner (${owner})`);
        continue;
      }
      if ((last.body ?? "").includes(REVIEW_TRIGGER)) {
        await runReviewVertical({ github, issue, getTokenFn, runAgent, clone, prDiff, dryRun, log, stats });
      } else {
        await runResearchVertical({ github, issue, comments, getTokenFn, runAgent, clone, dryRun, log, stats });
      }
    } catch (err) {
      stats.failed++;
      log(`ERROR #${issue.number}: ${err.message}`);
    }
  }

  log(`round done: ${stats.processed} ${dryRun ? "would post" : "posted"}, ${stats.skipped} skipped, ${stats.failed} failed`);
  return stats;
}

/** Give the clone to the unprivileged agent user (no-op without $AGENT_USER;
 *  tolerated when running unprivileged in development). */
function handToAgent(dir, log) {
  const user = process.env.AGENT_USER;
  if (!user) return;
  try {
    execFileSync("chown", ["-R", user, dir], { stdio: "ignore" });
  } catch (err) {
    if (err.code === "EPERM") {
      log(`warning: cannot chown ${dir} to ${user} (not root?) — the agent run will likely fail to start`);
      return;
    }
    throw new Error(`chown for agent user failed: ${err.message}`);
  }
}

async function runResearchVertical({ github, issue, comments, getTokenFn, runAgent, clone, dryRun, log, stats }) {
  const prompt = buildResearchPrompt({ issue, comments });
  if (dryRun) {
    log(`#${issue.number} [DRY_RUN] research prompt:\n${prompt}`);
    stats.processed++;
    return;
  }
  const work = await clone({ repo: github.repo, token: await getTokenFn() });
  try {
    handToAgent(work.dir, log);
    const text = await runAgent({ prompt, cwd: work.dir, tools: RESEARCH_TOOLS, systemAddendum: loadSystemAddendum() });
    await github.postComment(issue, `${MARKER}\n\n${text}`);
    log(`#${issue.number} posted research comment`);
  } finally {
    work.cleanup();
  }
  stats.processed++;
}

async function runReviewVertical({ github, issue, getTokenFn, runAgent, clone, prDiff, dryRun, log, stats }) {
  const prs = await github.getLinkedPullRequests(issue);
  if (prs.length === 0) {
    const body = `${MARKER}\n\nNo open or merged PRs are linked to this issue (a PR body mentioning it, or a Development-section link). Link one and re-trigger with \`${REVIEW_TRIGGER}\`.`;
    if (dryRun) log(`#${issue.number} [DRY_RUN] would post: ${body}`);
    else await github.postComment(issue, body);
    stats.processed++;
    return;
  }
  for (const pr of prs) {
    const previous = await github.getLastBotComment(pr.number);
    if (dryRun) {
      log(`#${issue.number} → PR #${pr.number} [DRY_RUN] review (previous review: ${previous ? "yes" : "no"})`);
      stats.processed++;
      continue;
    }
    const work = await clone({ repo: github.repo, token: await getTokenFn(), prNumber: pr.number });
    try {
      const diff = await prDiff({ dir: work.dir, baseRef: pr.baseRef });
      const prompt = buildReviewPrompt({ issue, pr, diff, previousReview: previous });
      handToAgent(work.dir, log);
      const text = await runAgent({ prompt, cwd: work.dir, tools: REVIEW_TOOLS, systemAddendum: loadSystemAddendum() });
      await github.postComment({ number: pr.number }, `${MARKER}\n\n${text}`);
      log(`#${issue.number} → PR #${pr.number} posted review`);
    } finally {
      work.cleanup();
    }
    stats.processed++;
  }
}

// --- main (only when executed directly) -------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dryRun = process.env.DRY_RUN === "1";
  const octokit = createGitHubOctokit({
    appId: process.env.GH_APP_ID,
    installationId: process.env.GH_INSTALLATION_ID,
    pemPath: process.env.KEY_PATH ?? join(here, "..", "key.pem"), // key lives at repo root
  });
  const github = new GitHub(octokit);
  const stats = await runRound({
    github,
    dryRun,
    getToken: async () => (await octokit.auth()).token,
    log: (m) => console.log(`[overcommit-bot] ${m}`),
  });
  if (stats.failed > 0) process.exit(1);
}
