// bot.test.mjs — round logic with stubbed GitHub + LLM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRound, isBotLogin, MARKER } from "./bot.mjs";

function makeGithub({ issues = [], commentsByIssue = {}, failGenerateOn } = {}) {
  const calls = { posts: [] };
  return {
    calls,
    listOpenIssues: async () => issues,
    getComments: async (issue) => commentsByIssue[issue.number] ?? [],
    postComment: async (issue, body) => { calls.posts.push({ number: issue.number, body }); return {}; },
  };
}

const issue = (n) => ({ number: n, title: `Issue ${n}`, body: "body" });
const humanComment = { user: { login: "MKuckert" }, body: "human", created_at: "2026-09-01T00:00:00Z" };
const botComment = { user: { login: "some-other-bot[bot]" }, body: "bot", created_at: "2026-09-02T00:00:00Z" };

test("isBotLogin", () => {
  assert.ok(isBotLogin("overcommit-bot[bot]"));
  assert.ok(!isBotLogin("MKuckert"));
  assert.ok(!isBotLogin(undefined));
});

test("skips issues whose last comment is by a bot; no LLM call, no post", async () => {
  const gh = makeGithub({ issues: [issue(1), issue(2)], commentsByIssue: { 1: [humanComment, botComment], 2: [humanComment] } });
  let generated = 0;
  const stats = await runRound({ github: gh, generate: async () => { generated++; return "note"; }, log: () => {} });
  assert.deepEqual(stats, { processed: 1, skipped: 1, failed: 0 });
  assert.equal(generated, 1); // only issue 2
  assert.deepEqual(gh.calls.posts.map((p) => p.number), [2]);
});

test("posts marker-prefixed LLM comment on fresh issues", async () => {
  const gh = makeGithub({ issues: [issue(7)] });
  const stats = await runRound({ github: gh, generate: async (o) => { assert.equal(o.issue.number, 7); return "Research."; }, log: () => {} });
  assert.deepEqual(stats, { processed: 1, skipped: 0, failed: 0 });
  assert.match(gh.calls.posts[0].body, new RegExp(`^${MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n\nResearch\.$`));
});

test("dryRun: nothing is posted", async () => {
  const gh = makeGithub({ issues: [issue(3)] });
  let logged = "";
  const stats = await runRound({ github: gh, generate: async () => "note", dryRun: true, log: (m) => (logged += m) });
  assert.deepEqual(stats, { processed: 1, skipped: 0, failed: 0 });
  assert.equal(gh.calls.posts.length, 0);
  assert.match(logged, /DRY_RUN/);
});

test("per-issue LLM failure: counted, other issues continue", async () => {
  const gh = makeGithub({ issues: [issue(1), issue(2)] });
  const stats = await runRound({
    github: gh,
    generate: async ({ issue }) => { if (issue.number === 1) throw new Error("llm down"); return "ok"; },
    log: () => {},
  });
  assert.deepEqual(stats, { processed: 1, skipped: 0, failed: 1 });
  assert.deepEqual(gh.calls.posts.map((p) => p.number), [2]);
});

test("failure to list issues: round reports failure, no crash", async () => {
  const gh = { listOpenIssues: async () => { throw new Error("HTTP 403"); }, getComments: async () => [], postComment: async () => {} };
  const stats = await runRound({ github: gh, generate: async () => "x", log: () => {} });
  assert.equal(stats.failed, 1);
});

test("recent comments passed to LLM are the last five", async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ user: { login: `u${i}` }, body: `c${i}`, created_at: "" }));
  const gh = makeGithub({ issues: [issue(9)], commentsByIssue: { 9: many } });
  let seen;
  await runRound({ github: gh, generate: async ({ recentComments }) => { seen = recentComments; return "x"; }, log: () => {} });
  assert.equal(seen.length, 5);
  assert.equal(seen[0].body, "c3");
});
