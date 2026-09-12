// git.test.mjs — clone + diff helpers with a fake execFile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { cloneForBot, getPrDiff } from "./git.mjs";

function fakeExec() {
  const calls = [];
  const impl = (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, "", ""); };
  return { calls, impl };
}

test("clone: token via askpass env indirection; PR head fetched and checked out", async () => {
  const fe = fakeExec();
  const { dir, cleanup } = await cloneForBot({ repo: "o/r", token: "ghs_secret", prNumber: 7, execImpl: fe.impl });
  const [cloneCall, fetchCall, checkoutCall] = fe.calls;
  assert.ok(cloneCall.args.includes("clone"));
  assert.ok(cloneCall.args.includes("https://github.com/o/r.git"));
  assert.equal(fetchCall.args.at(-1), "pull/7/head");
  assert.deepEqual(checkoutCall.args, ["-C", dir, "checkout", "--quiet", "FETCH_HEAD"]);
  // the token never lands on disk or in argv — only in the child env
  const askpass = readFileSync(cloneCall.opts.env.GIT_ASKPASS, "utf8");
  assert.ok(!askpass.includes("ghs_secret"));
  assert.equal(cloneCall.opts.env.GIT_BOT_TOKEN, "ghs_secret");
  for (const c of fe.calls) assert.ok(!JSON.stringify(c.args).includes("ghs_secret"));
  cleanup();
  assert.equal(existsSync(dir), false);
});

test("clone without PR: no fetch/checkout", async () => {
  const fe = fakeExec();
  const { cleanup } = await cloneForBot({ repo: "o/r", token: "t", execImpl: fe.impl });
  assert.equal(fe.calls.length, 1);
  cleanup();
});

test("clone failure cleans up and throws", async () => {
  const impl = (file, args, opts, cb) => cb(new Error("spawn fail"), "", "denied");
  await assert.rejects(cloneForBot({ repo: "o/r", token: "t", execImpl: impl }), /clone failed/);
});

test("getPrDiff returns log/stat/diff and truncates large diffs", async () => {
  const impl = (file, args, opts, cb) => {
    if (args.includes("log")) cb(null, "abc123 fix\n", "");
    else if (args[args.indexOf("diff") + 1] === "--stat") cb(null, "a.txt | 2 +-\n", "");
    else cb(null, "x".repeat(70_000), "");
  };
  const d = await getPrDiff({ dir: "/tmp/x", baseRef: "main", maxChars: 60_000, execImpl: impl });
  assert.equal(d.log, "abc123 fix");
  assert.match(d.stat, /a\.txt/);
  assert.ok(d.truncated);
  assert.equal(d.diff.length, 60_000);
});

test("getPrDiff falls back to origin/HEAD when the base branch is gone", async () => {
  const impl = (file, args, opts, cb) => {
    if (args.includes("rev-parse")) cb(new Error("not a ref"), "", "fatal: ...");
    else if (args.includes("log")) cb(null, "abc123 fix\n", "");
    else if (args[args.indexOf("diff") + 1] === "--stat") cb(null, "a.txt | 2 +-\n", "");
    else cb(null, "-x +y\n", "");
  };
  const d = await getPrDiff({ dir: "/tmp/x", baseRef: "deleted-branch", execImpl: impl });
  assert.match(d.baseNote, /default branch/);
  assert.equal(d.truncated, false);
});
