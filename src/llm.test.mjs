// llm.test.mjs — unit tests for the model client (stubbed fetch, temp settings file).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModelApiKey, buildPrompt, loadSystemPrompt, generateResearchComment } from "./llm.mjs";

const dir = mkdtempSync(join(tmpdir(), "ghbot-llm-"));
const settingsFile = join(dir, "settings.json");
writeFileSync(settingsFile, JSON.stringify({ auth: { api_key: "test-key-123" }, server: { port: 11437 } }));

const issue = { number: 100, title: "gh Integration bot", body: "We need a bot." };
const comments = [{ user: { login: "MKuckert" }, created_at: "2026-09-01T00:00:00Z", body: "First note" }];

test("resolveModelApiKey: explicit key wins, settings file fallback, fail loud when absent", () => {
  assert.equal(resolveModelApiKey({ apiKey: "explicit", settingsFile }), "explicit");
  assert.equal(resolveModelApiKey({ settingsFile }), "test-key-123");
  assert.throws(() => resolveModelApiKey({}), /no MODEL_API_KEY set/);
  assert.throws(() => resolveModelApiKey({ settingsFile: join(dir, "nope.json") }), /cannot read model settings/);
  writeFileSync(join(dir, "empty.json"), JSON.stringify({}));
  assert.throws(() => resolveModelApiKey({ settingsFile: join(dir, "empty.json") }), /auth.api_key missing/);
});

test("buildPrompt: template from prompts/bot_prompt.md, contains issue identity, body and recent comments", () => {
  const prompt = buildPrompt({ issue, recentComments: comments });
  assert.match(prompt, /research assistant/); // template instructions present
  assert.match(prompt, /#100: gh Integration bot/);
  assert.match(prompt, /We need a bot\./);
  assert.match(prompt, /MKuckert/);
  assert.match(prompt, /First note/);
});

test("buildPrompt: omits empty sections (no body, no comments)", () => {
  const prompt = buildPrompt({ issue: { number: 7, title: "T" } });
  assert.match(prompt, /#7: T/);
  assert.doesNotMatch(prompt, /Issue body:/);
  assert.doesNotMatch(prompt, /Recent comments:/);
});

test("loadSystemPrompt: reads prompts/system.md", () => {
  assert.match(loadSystemPrompt(), /research assistant/);
});

test("generateResearchComment: posts to /chat/completions with key, model and messages", async () => {
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ choices: [{ message: { content: "  Research note. " } }] }) };
  };
  const out = await generateResearchComment({
    issue, recentComments: comments,
    baseUrl: "http://192.168.178.61:11437/v1", apiKey: "k", model: "m", fetchImpl,
  });
  assert.equal(out, "Research note."); // trimmed
  assert.match(captured.url, /\/chat\/completions$/);
  assert.equal(captured.opts.headers.Authorization, "Bearer k");
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.model, "m");
  assert.equal(body.messages.length, 2);
  assert.match(body.messages[0].content, /research assistant/); // system prompt from prompts/system.md
  assert.match(body.messages[1].content, /#100: gh Integration bot/);
});

test("generateResearchComment: missing base URL / model name fail loud (no defaults)", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [] }) });
  await assert.rejects(
    generateResearchComment({ issue, apiKey: "k", model: "m", fetchImpl }),
    /no model base URL/,
  );
  await assert.rejects(
    generateResearchComment({ issue, baseUrl: "http://x/v1", apiKey: "k", fetchImpl }),
    /no model name/,
  );
});

test("generateResearchComment: non-2xx throws with status and body (fail loud)", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, text: async () => "model loading" });
  await assert.rejects(
    generateResearchComment({ issue, baseUrl: "http://x/v1", apiKey: "k", model: "m", fetchImpl }),
    /HTTP 503.*model loading/,
  );
});

test("generateResearchComment: empty completion throws instead of posting nothing", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [] }) });
  await assert.rejects(
    generateResearchComment({ issue, baseUrl: "http://x/v1", apiKey: "k", model: "m", fetchImpl }),
    /returned no content/,
  );
});

test("generateResearchComment: unreachable server surfaces the error", async () => {
  const fetchImpl = async () => { throw new Error("fetch failed: ECONNREFUSED"); };
  await assert.rejects(
    generateResearchComment({ issue, baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m", fetchImpl }),
    /ECONNREFUSED/,
  );
});
