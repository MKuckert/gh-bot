// llm.mjs — OpenAI-compatible model client (`/v1/chat/completions`) for
// generating research comments. Prompts live in prompts/bot_prompt.md and
// prompts/system.md so they can be adjusted without touching code.
// Fail-loud: unreachable server or non-2xx throws with status + body; the bot
// never posts fabricated content.

import { readFileSync } from "node:fs";

const PROMPTS_DIR = new URL("../prompts/", import.meta.url);

/**
 * Resolve the model API key. Explicit MODEL_API_KEY wins; otherwise read
 * auth.api_key from the provider settings file (MODEL_SETTINGS_FILE).
 */
export function resolveModelApiKey({ apiKey = process.env.MODEL_API_KEY, settingsFile } = {}) {
  if (apiKey) return apiKey;
  const file = settingsFile ?? process.env.MODEL_SETTINGS_FILE;
  if (!file) throw new Error("llm: no MODEL_API_KEY set and no model settings file given (MODEL_SETTINGS_FILE)");
  let settings;
  try {
    settings = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`llm: cannot read model settings at ${file}: ${err.message}`);
  }
  if (!settings?.auth?.api_key) throw new Error(`llm: auth.api_key missing in ${file}`);
  return settings.auth.api_key;
}

/** Load the system prompt (prompts/system.md). */
export function loadSystemPrompt() {
  return readFileSync(new URL("system.md", PROMPTS_DIR), "utf8").trim();
}

/** Build the user prompt for one issue from prompts/bot_prompt.md. */
export function buildPrompt({ issue, recentComments = [] }) {
  const comments = recentComments
    .map((c) => `--- ${c.user?.login ?? "unknown"} (${c.created_at}) ---\n${c.body}`)
    .join("\n\n");
  const sections = [`Issue #${issue.number}: ${issue.title}`];
  if (issue.body) sections.push(`Issue body:\n${issue.body}`);
  if (comments) sections.push(`Recent comments:\n${comments}`);
  return loadBotPrompt().replaceAll("{{issue}}", sections.join("\n\n")).trim();
}

/** Load the user-prompt template (prompts/bot_prompt.md). */
export function loadBotPrompt() {
  return readFileSync(new URL("bot_prompt.md", PROMPTS_DIR), "utf8");
}

/**
 * Ask the model for a research comment.
 * @returns {Promise<string>} the comment text
 */
export async function generateResearchComment({ issue, recentComments = [], baseUrl, apiKey, model, fetchImpl = fetch }) {
  const base = (baseUrl ?? process.env.MODEL_BASE_URL)?.replace(/\/$/, "");
  if (!base) throw new Error("llm: no model base URL (set MODEL_BASE_URL in .env or pass baseUrl)");
  const name = model ?? process.env.MODEL_NAME;
  if (!name) throw new Error("llm: no model name (set MODEL_NAME in .env or pass model)");
  const key = resolveModelApiKey({ apiKey, settingsFile: process.env.MODEL_SETTINGS_FILE });
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: name,
      messages: [
        { role: "system", content: loadSystemPrompt() },
        { role: "user", content: buildPrompt({ issue, recentComments }) },
      ],
      max_tokens: 2000,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`llm: model request failed (HTTP ${res.status}) from ${base}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`llm: model returned no content: ${JSON.stringify(json).slice(0, 300)}`);
  return content.trim();
}
