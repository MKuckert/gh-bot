// prompts.test.mjs — template building, incl. replacement-pattern safety.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResearchPrompt, buildReviewPrompt, loadSystemAddendum } from "./prompts.mjs";

test("research prompt contains title, body and full thread", () => {
  const p = buildResearchPrompt({
    issue: { number: 7, title: "Auth is broken", body: "it fails" },
    comments: [
      { user: { login: "a" }, body: "first", created_at: "" },
      { user: { login: "mkuckert" }, body: "please check", created_at: "" },
    ],
  });
  assert.match(p, /#7: Auth is broken/);
  assert.match(p, /it fails/);
  assert.match(p, /first/); // full thread, not just the last comment
});

test("replacement patterns in content are treated as plain text ($& injection)", () => {
  const p = buildResearchPrompt({
    issue: { number: 1, title: "x", body: "evil $& ${'$'}' payload" },
    comments: [],
  });
  assert.ok(p.includes("evil $& ${'$'}' payload")); // verbatim, not interpreted
  assert.ok(!p.includes("{{issue}}"));
});

test("review prompt carries PR, diff and previous review; function-safe", () => {
  const p = buildReviewPrompt({
    issue: { number: 1, title: "issue" },
    pr: { number: 42, title: "PR", state: "open", body: "b$&", headRef: "f", headSha: "a".repeat(40), baseRef: "main" },
    diff: { log: "abc fix", stat: "1 file", diff: "@@ -1 +1 @@", truncated: false, baseNote: "fallback note" },
    previousReview: { body: "MARKER\n\n$& old finding" },
  });
  assert.match(p, /PR #42/);
  assert.match(p, /abc fix/);
  assert.match(p, /\$& old finding/); // verbatim
  assert.match(p, /fallback note/);
});

test("system addendum loads and mentions untrusted content", () => {
  const s = loadSystemAddendum();
  assert.match(s, /UNTRUSTED DATA/);
});
