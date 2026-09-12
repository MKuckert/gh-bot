// bot.test.mjs — round logic with stubbed GitHub, agent, clone and diff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRound, MARKER, REVIEW_TRIGGER, RESEARCH_TOOLS, REVIEW_TOOLS } from "./bot.mjs";
import { isBotLogin } from "./github.mjs";

function makeGithub({ issues = [], commentsByNumber = {}, prsByIssue = {}, botComments = {} } = {}) {
  const calls = { posts: [] };
  return {
    repo: "owner/repo",
    calls,
    listOpenIssues: async () => issues,
    getComments: async (t) => commentsByNumber[t.number] ?? [],
    getLinkedPullRequests: async (issue) => prsByIssue[issue.number] ?? [],
    getLastBotComment: async (n) => botComments[n] ?? null,
    postComment: async (t, body) => { calls.posts.push({ number: t.number, body }); return {}; },
  };
}

function makeAgent() {
  const calls = [];
  return { calls, run: async (o) => { calls.push(o); return "AGENT_OUT"; } };
}

function makeClone() {
  const calls = [];
  return { calls, clone: async (o) => { calls.push(o); return { dir: "/tmp/fake-work", cleanup: () => {} }; } };
}

const DIFF = { log: "abc123 fix thing", stat: "1 file changed", diff: "@@ -1 +1 @@", truncated: false };
const getToken = async () => "ghs_test";

const issue = (n) => ({ number: n, title: `Issue ${n}`, body: "issue body" });
const ownerComment = (body = "please look into this") => ({ user: { login: "mkuckert" }, body, created_at: "2026-09-01T00:00:00Z" });
const otherComment = { user: { login: "random-user" }, body: "ignore me", created_at: "2026-09-01T01:00:00Z" };
const botComment = { user: { login: "other-bot[bot]" }, body: "bot", created_at: "2026-09-01T02:00:00Z" };
const pr = (n) => ({ number: n, title: `PR ${n}`, state: "open", body: "pr body", headRef: "feat", headSha: "a".repeat(40), baseRef: "main" });

test("isBotLogin", () => {
  assert.ok(isBotLogin("overcommit-bot[bot]"));
  assert.ok(!isBotLogin("mkuckert"));
  assert.ok(!isBotLogin(undefined));
});

test("no comments: skipped, no agent run", async () => {
  const gh = makeGithub({ issues: [issue(1)] });
  const agent = makeAgent();
  const stats = await runRound({ github: gh, runAgent: agent.run, clone: makeClone().clone, getToken, log: () => {} });
  assert.deepEqual(stats, { processed: 0, skipped: 1, failed: 0 });
  assert.equal(agent.calls.length, 0);
});

test("last comment by another human: skipped", async () => {
  const gh = makeGithub({ issues: [issue(1)], commentsByNumber: { 1: [ownerComment(), otherComment] } });
  const agent = makeAgent();
  const stats = await runRound({ github: gh, runAgent: agent.run, clone: makeClone().clone, getToken, log: () => {} });
  assert.deepEqual(stats, { processed: 0, skipped: 1, failed: 0 });
  assert.equal(agent.calls.length, 0);
});

test("last comment by a bot: skipped (owner earlier does not count)", async () => {
  const gh = makeGithub({ issues: [issue(1)], commentsByNumber: { 1: [ownerComment(), botComment] } });
  const agent = makeAgent();
  const stats = await runRound({ github: gh, runAgent: agent.run, clone: makeClone().clone, getToken, log: () => {} });
  assert.deepEqual(stats, { processed: 0, skipped: 1, failed: 0 });
});

test("owner comment: research vertical — full thread to agent, post on issue with marker", async () => {
  const many = [
    ...Array.from({ length: 8 }, (_, i) => ({ user: { login: `u${i}` }, body: `c${i}`, created_at: "" })),
    ownerComment("what is the deal with auth?"),
  ];
  const gh = makeGithub({ issues: [issue(7)], commentsByNumber: { 7: many } });
  const agent = makeAgent();
  const cl = makeClone();
  const stats = await runRound({ github: gh, runAgent: agent.run, clone: cl.clone, getToken, log: () => {} });
  assert.deepEqual(stats, { processed: 1, skipped: 0, failed: 0 });
  assert.equal(agent.calls.length, 1);
  assert.match(agent.calls[0].prompt, /c0/); // full thread, not just the last five
  assert.match(agent.calls[0].prompt, /what is the deal with auth\?/);
  assert.deepEqual(agent.calls[0].tools, RESEARCH_TOOLS);
  assert.ok(agent.calls[0].tools.includes("web_search"));
  assert.equal(cl.calls.length, 1);
  assert.equal(gh.calls.posts.length, 1);
  assert.equal(gh.calls.posts[0].number, 7);
  assert.ok(gh.calls.posts[0].body.startsWith(`${MARKER}\n\nAGENT_OUT`));
});

test("owner comment with trigger: review vertical — clone at PR head, read-only agent, post on PR", async () => {
  const gh = makeGithub({
    issues: [issue(1)],
    commentsByNumber: { 1: [ownerComment(`go ahead ${REVIEW_TRIGGER}`)] },
    prsByIssue: { 1: [pr(42)] },
  });
  const agent = makeAgent();
  const cl = makeClone();
  const stats = await runRound({ github: gh, runAgent: agent.run, clone: cl.clone, prDiff: async () => DIFF, getToken, log: () => {} });
  assert.deepEqual(stats, { processed: 1, skipped: 0, failed: 0 });
  assert.equal(cl.calls.length, 1);
  assert.equal(cl.calls[0].prNumber, 42);
  assert.deepEqual(agent.calls[0].tools, REVIEW_TOOLS);
  assert.match(agent.calls[0].prompt, /PR #42/);
  assert.match(agent.calls[0].prompt, /abc123 fix thing/); // diff included
  assert.equal(gh.calls.posts.length, 1);
  assert.equal(gh.calls.posts[0].number, 42); // posted on the PR, not the issue
});

test("re-review: previous bot review is fed into the prompt", async () => {
  const gh = makeGithub({
    issues: [issue(1)],
    commentsByNumber: { 1: [ownerComment(REVIEW_TRIGGER)] },
    prsByIssue: { 1: [pr(42)] },
    botComments: { 42: { user: { login: "overcommit-bot[bot]" }, body: "MARKER\n\nold finding X" } },
  });
  const agent = makeAgent();
  await runRound({ github: gh, runAgent: agent.run, clone: makeClone().clone, prDiff: async () => DIFF, getToken, log: () => {} });
  assert.match(agent.calls[0].prompt, /old finding X/);
  assert.match(agent.calls[0].prompt, /re-review/i);
});

test("trigger with no linked PRs: feedback comment on issue, no agent run", async () => {
  const gh = makeGithub({ issues: [issue(1)], commentsByNumber: { 1: [ownerComment(REVIEW_TRIGGER)] } });
  const agent = makeAgent();
  const cl = makeClone();
  const stats = await runRound({ github: gh, runAgent: agent.run, clone: cl.clone, getToken, log: () => {} });
  assert.deepEqual(stats, { processed: 1, skipped: 0, failed: 0 });
  assert.equal(agent.calls.length, 0);
  assert.equal(cl.calls.length, 0);
  assert.equal(gh.calls.posts[0].number, 1);
  assert.match(gh.calls.posts[0].body, /No open or merged PRs/);
});

test("dryRun: no posts, no clones, no agent runs — prompt is printed", async () => {
  const gh = makeGithub({ issues: [issue(3)], commentsByNumber: { 3: [ownerComment()] } });
  const agent = makeAgent();
  const cl = makeClone();
  let logged = "";
  const stats = await runRound({ github: gh, runAgent: agent.run, clone: cl.clone, getToken, dryRun: true, log: (m) => (logged += m) });
  assert.deepEqual(stats, { processed: 1, skipped: 0, failed: 0 });
  assert.equal(gh.calls.posts.length, 0);
  assert.equal(cl.calls.length, 0);
  assert.equal(agent.calls.length, 0);
  assert.match(logged, /DRY_RUN/);
  assert.match(logged, /research prompt/);
});

test("dryRun review vertical: no crash, no posts, no clones, no agent runs", async () => {
  const gh = makeGithub({
    issues: [issue(1)],
    commentsByNumber: { 1: [ownerComment(REVIEW_TRIGGER)] },
    prsByIssue: { 1: [pr(42)] },
  });
  const agent = makeAgent();
  const cl = makeClone();
  let logged = "";
  const stats = await runRound({ github: gh, runAgent: agent.run, clone: cl.clone, getToken, dryRun: true, log: (m) => (logged += m) });
  assert.deepEqual(stats, { processed: 1, skipped: 0, failed: 0 });
  assert.equal(gh.calls.posts.length, 0);
  assert.equal(cl.calls.length, 0);
  assert.equal(agent.calls.length, 0);
  assert.match(logged, /PR #42.*DRY_RUN/);
});

test("agent failure: counted, other issues continue", async () => {
  const gh = makeGithub({
    issues: [issue(1), issue(2)],
    commentsByNumber: { 1: [ownerComment()], 2: [ownerComment()] },
  });
  const agent = { calls: [], run: async ({ prompt }) => { if (prompt.includes("Issue #1")) throw new Error("llm down"); return "ok"; } };
  const stats = await runRound({ github: gh, runAgent: agent.run, clone: makeClone().clone, getToken, log: () => {} });
  assert.deepEqual(stats, { processed: 1, skipped: 0, failed: 1 });
  assert.deepEqual(gh.calls.posts.map((p) => p.number), [2]);
});

test("failure to list issues: round reports failure, no crash", async () => {
  const gh = { listOpenIssues: async () => { throw new Error("HTTP 403"); } };
  const stats = await runRound({ github: gh, log: () => {} });
  assert.equal(stats.failed, 1);
});
