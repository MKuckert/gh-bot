// prompts.mjs — load prompt templates (prompts/*.md) and build per-vertical
// user prompts. Templates use {{placeholder}} substitution.

import { readFileSync } from "node:fs";

const PROMPTS_DIR = new URL("../prompts/", import.meta.url);

export function loadTemplate(name) {
  return readFileSync(new URL(name, PROMPTS_DIR), "utf8");
}

/** Security addendum appended to pi's default system prompt (prompts/system.md). */
export function loadSystemAddendum() {
  return loadTemplate("system.md").trim();
}

function formatComments(comments) {
  return comments
    .map((c) => `--- ${c.user?.login ?? "unknown"} (${c.created_at}) ---\n${c.body ?? ""}`)
    .join("\n\n");
}

/** Research vertical: issue + full comment thread (oldest → newest). */
export function buildResearchPrompt({ issue, comments }) {
  const sections = [`Issue #${issue.number}: ${issue.title}`];
  if (issue.body) sections.push(`Issue body:\n${issue.body}`);
  if (comments.length) sections.push(`Full comment thread (oldest → newest):\n${formatComments(comments)}`);
  // Function replacement: issue/PR content may contain $& / $' patterns that
  // String.replace would interpret — treat the value as plain text.
  return loadTemplate("bot_prompt.md").replaceAll("{{issue}}", () => sections.join("\n\n")).trim();
}

/** Review vertical: PR metadata + orchestrator-computed diff + previous review. */
export function buildReviewPrompt({ issue, pr, diff, previousReview }) {
  const prSection = [
    `PR #${pr.number}: ${pr.title}`,
    `State: ${pr.state} — head: ${pr.headRef ?? "?"} (${(pr.headSha ?? "?").slice(0, 12)}), base: ${pr.baseRef ?? "?"}`,
    `Linked issue #${issue.number}: ${issue.title}`,
    pr.body ? `\nPR description:\n${pr.body}` : "",
  ].join("\n");
  const diffSection = [
    "Commits:",
    diff.log || "(none)",
    "",
    diff.stat,
    "",
    diff.diff,
    diff.truncated ? "(diff truncated — read the files directly for the full picture)" : "",
    diff.baseNote ?? "",
  ].join("\n");
  const prev = previousReview ? previousReview.body : "(none — first review)";
  return loadTemplate("review_prompt.md")
    .replaceAll("{{pr}}", () => prSection)
    .replaceAll("{{diff}}", () => diffSection)
    .replaceAll("{{previousReview}}", () => prev)
    .trim();
}
