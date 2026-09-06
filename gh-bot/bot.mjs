// bot.mjs — one round: open issues → skip-check → LLM research comment → post.
// Fail-loud: per-issue errors are logged and counted; the round exits non-zero
// if anything failed. DRY_RUN=1 prints instead of posting.

import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AppAuth } from "./auth.mjs";
import { GitHub } from "./github.mjs";
import { generateResearchComment } from "./llm.mjs";

export const MARKER = "🤖 **[overcommit-bot]**";
const RECENT_COMMENTS_FOR_PROMPT = 5;

export function isBotLogin(login) {
  return typeof login === "string" && login.endsWith("[bot]");
}

/**
 * Run one bot round.
 * @param {object} deps
 * @param {import("./github.mjs").GitHub} [deps.github]
 * @param {(opts: object) => Promise<string>} [deps.generate]
 * @param {boolean}  [deps.dryRun]   print instead of posting
 * @param {(msg: string) => void}    [deps.log]
 * @returns {Promise<{processed: number, skipped: number, failed: number}>}
 */
export async function runRound({ github, generate = generateResearchComment, dryRun = false, log = console.log } = {}) {
  if (!github) throw new Error("runRound: no github client provided");
  const stats = { processed: 0, skipped: 0, failed: 0 };

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
      if (last && isBotLogin(last.user?.login)) {
        stats.skipped++;
        log(`#${issue.number} skip — last comment already by a bot (${last.user.login})`);
        continue;
      }
      const text = await generate({ issue, recentComments: comments.slice(-RECENT_COMMENTS_FOR_PROMPT) });
      const body = `${MARKER}\n\n${text}`;
      if (dryRun) {
        log(`#${issue.number} [DRY_RUN] would post:\n${body}`);
      } else {
        await github.postComment(issue, body);
        log(`#${issue.number} posted research comment`);
      }
      stats.processed++;
    } catch (err) {
      stats.failed++;
      log(`ERROR #${issue.number}: ${err.message}`);
    }
  }

  log(`round done: ${stats.processed} posted, ${stats.skipped} skipped, ${stats.failed} failed`);
  return stats;
}

// --- main (only when executed directly) -------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dryRun = process.env.DRY_RUN === "1";
  const auth = new AppAuth({
    appId: process.env.GH_APP_ID,
    installationId: process.env.GH_INSTALLATION_ID,
    pemPath: join(here, "key.pem"),
  });
  const stats = await runRound({ github: new GitHub(auth), dryRun, log: (m) => console.log(`[overcommit-bot] ${m}`) });
  if (stats.failed > 0) process.exit(1);
}
