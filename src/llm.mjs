// llm.mjs — omlx client (OpenAI-compatible /v1) for generating research comments.
// Fail-loud: unreachable server or non-2xx throws with status + body; the bot
// never posts fabricated content.

import { readFileSync } from "node:fs";

/**
 * Resolve the omlx API key. Explicit OMLX_API_KEY wins; otherwise read
 * auth.api_key from the omlx settings file (default: <repo>/omlx/settings.json).
 */
export function resolveOmlxApiKey({ apiKey = process.env.OMLX_API_KEY, settingsFile } = {}) {
  if (apiKey) return apiKey;
  const file = settingsFile ?? process.env.OMLX_SETTINGS_FILE;
  if (!file) throw new Error("llm: no OMLX_API_KEY set and no omlx settings file given (OMLX_SETTINGS_FILE)");
  let settings;
  try {
    settings = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`llm: cannot read omlx settings at ${file}: ${err.message}`);
  }
  if (!settings?.auth?.api_key) throw new Error(`llm: auth.api_key missing in ${file}`);
  return settings.auth.api_key;
}

/** Build the prompt for one issue. */
export function buildPrompt({ issue, recentComments = [] }) {
  const comments = recentComments
    .map((c) => `--- ${c.user?.login ?? "unknown"} (${c.created_at}) ---\n${c.body}`)
    .join("\n\n");
  return [
    "You are a research assistant that posts periodic progress comments on GitHub issues.",
    "Write ONE concise markdown comment (max ~250 words) that:",
    "1. summarizes the current state of the issue based on its title, body and recent comments,",
    "2. adds a short research note: likely next steps, open questions, or relevant considerations,",
    "3. stays factual about what the issue actually says — do not invent status, decisions or people.",
    "Output only the comment text, no preamble, no code fences around the whole comment.",
    "",
    `Issue #${issue.number}: ${issue.title}`,
    issue.body ? `\nIssue body:\n${issue.body}` : "",
    comments ? `\nRecent comments:\n${comments}` : "",
  ].join("\n");
}

/**
 * Ask omlx for a research comment.
 * @returns {Promise<string>} the comment text
 */
export async function generateResearchComment({ issue, recentComments = [], baseUrl, apiKey, model, fetchImpl = fetch }) {
  const base = (baseUrl ?? process.env.OMLX_BASE_URL ?? "http://localhost:11437/v1").replace(/\/$/, "");
  const key = resolveOmlxApiKey({ apiKey, settingsFile: process.env.OMLX_SETTINGS_FILE });
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model ?? process.env.OMLX_MODEL ?? "qwen3.8-27B-oQ4e",
      messages: [
        { role: "system", content: "You are a precise, terse research assistant for GitHub issue tracking." },
        { role: "user", content: buildPrompt({ issue, recentComments }) },
      ],
      max_tokens: 2000,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`llm: omlx request failed (HTTP ${res.status}) from ${base}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`llm: omlx returned no content: ${JSON.stringify(json).slice(0, 300)}`);
  return content.trim();
}
