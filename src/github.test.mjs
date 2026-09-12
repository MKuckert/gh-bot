// github.test.mjs — REST helpers with a fake Octokit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHub, isBotLogin } from "./github.mjs";

const REPO = "owner/repo";

function fakeOctokit({ commentsPages = [], timelinePages = [], issuePages = [] } = {}) {
  return {
    rest: {
      issues: {
        listForRepo: async ({ page }) => ({ data: issuePages[page - 1] ?? [] }),
        listComments: async ({ page }) => ({ data: commentsPages[page - 1] ?? [] }),
        listTimeline: async ({ page }) => ({ data: timelinePages[page - 1] ?? [] }),
        createComment: async () => ({ data: {} }),
      },
    },
  };
}

test("isBotLogin", () => {
  assert.ok(isBotLogin("overcommit-app[bot]"));
  assert.ok(!isBotLogin("mkuckert"));
  assert.ok(!isBotLogin(undefined));
});

test("listOpenIssues paginates and drops PRs", async () => {
  const p1 = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `i${i}` }));
  const p2 = [{ number: 101, title: "last" }, { number: 102, title: "a PR", pull_request: {} }];
  const gh = new GitHub(fakeOctokit({ issuePages: [p1, p2] }), { repo: REPO });
  const issues = await gh.listOpenIssues();
  assert.equal(issues.length, 101); // PR filtered out
});

test("getComments paginates until a short page", async () => {
  const p1 = Array.from({ length: 100 }, (_, i) => ({ user: { login: "u" }, body: `c${i}` }));
  const p2 = [{ user: { login: "v" }, body: "last" }];
  const gh = new GitHub(fakeOctokit({ commentsPages: [p1, p2] }), { repo: REPO });
  const all = await gh.getComments({ number: 1 });
  assert.equal(all.length, 101);
  assert.equal(all.at(-1).body, "last");
});

test("getLinkedPullRequests: same-repo open/merged PRs, deduped, cross-repo excluded", async () => {
  const pr = (n, state, extra = {}) => ({
    number: n, title: `PR ${n}`, state, body: "b", pull_request: extra,
    repository: { full_name: REPO },
    head: { ref: `br${n}`, sha: "s".repeat(40) }, base: { ref: "main" },
  });
  const timeline = [
    { event: "cross-referenced", source: { issue: pr(10, "open") } },
    { event: "cross-referenced", source: { issue: pr(10, "open") } }, // duplicate reference
    // merged PRs arrive as state "closed" + pull_request.merged_at (real API shape)
    { event: "cross-referenced", source: { issue: pr(11, "closed", { merged_at: "2026-09-01T00:00:00Z" }) } },
    { event: "cross-referenced", source: { issue: pr(12, "closed") } }, // closed-unmerged: excluded
    { event: "cross-referenced", source: { issue: { ...pr(13, "open"), repository: { full_name: "other/repo" } } } }, // other repo: excluded
    { event: "cross-referenced", source: { issue: { number: 14, title: "plain issue", state: "open" } } }, // not a PR
    { event: "commented" },
  ];
  const gh = new GitHub(fakeOctokit({ timelinePages: [timeline] }), { repo: REPO });
  const prs = await gh.getLinkedPullRequests({ number: 1 });
  assert.deepEqual(prs.map((p) => p.number), [10, 11]);
  assert.equal(prs[0].baseRef, "main");
});

test("getLastBotComment matches only the app's own login", async () => {
  const comments = [
    { user: { login: "mkuckert" }, body: "hi" },
    { user: { login: "github-actions[bot]" }, body: "Build failed" }, // another bot: not ours
    { user: { login: "overcommit-app[bot]" }, body: "our review" },
    { user: { login: "mkuckert" }, body: "thanks" },
  ];
  const gh = new GitHub(fakeOctokit({ commentsPages: [comments] }), { repo: REPO });
  assert.equal((await gh.getLastBotComment(5)).body, "our review");

  const none = new GitHub(fakeOctokit({ commentsPages: [[comments[0]]] }), { repo: REPO });
  assert.equal(await none.getLastBotComment(5), null);
});

test("splitRepo rejects malformed GH_REPO", () => {
  const gh = new GitHub({}, { repo: "no-slash" });
  assert.throws(() => gh.splitRepo(), /owner\/name/);
});
