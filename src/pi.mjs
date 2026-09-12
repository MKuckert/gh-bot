// pi.mjs — run one headless pi agent (`pi -p`) and return its final output.
//
// Security model:
//   - the agent runs as an unprivileged user (AGENT_USER, default "botagent")
//     via runuser — it cannot read the bot's credentials or the host home;
//   - a strict tool allowlist (--tools) — research gets read + web, review
//     gets read only; no shell, no writes, ever;
//   - the agent's working directory is a fresh clone it owns; there is nothing
//     else on the machine it needs.
// Fail-loud: non-zero exit, empty output or timeout throws; the bot never
// posts on a failed run.

import { spawn } from "node:child_process";

export const DEFAULT_PROVIDER = "omlx";
export const DEFAULT_MODEL = "qwen3.8-27B-oQ4e";
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/**
 * Build the pi CLI arguments for one headless run (prompt goes after `--`).
 */
export function buildPiArgs({ provider, model, tools = [], systemAddendum }) {
  const args = ["-p", "--no-session", "--provider", provider, "--model", model];
  if (tools.length) args.push("--tools", tools.join(","));
  if (systemAddendum) args.push("--append-system-prompt", systemAddendum);
  return [...args, "--"];
}

/**
 * Run one headless pi agent.
 * @param {object} opts
 * @param {string}   opts.prompt            user prompt (single argv message)
 * @param {string}   opts.cwd               working dir the agent may read (fresh clone)
 * @param {string[]} [opts.tools]           strict tool allowlist
 * @param {string}   [opts.systemAddendum]  appended to pi's default system prompt
 * @param {string}   [opts.provider]        default $PI_PROVIDER or omlx
 * @param {string}   [opts.model]           default $PI_MODEL or the local model
 * @param {number}   [opts.timeoutMs]       default 15 min
 * @param {string}   [opts.agentUser]       unprivileged user; default $AGENT_USER or
 *                                          "botagent"; "" = run as current user (dev/tests)
 * @param {string}   [opts.agentHome]       $HOME for the agent (default /var/lib/overcommit)
 * @param {string}   [opts.piBin]           pi binary (default $PI_BIN or "pi")
 * @param {Function} [opts.spawnImpl]       injectable spawn (tests)
 * @returns {Promise<string>} the agent's final output text
 */
export function runPiAgent({ prompt, cwd, tools = [], systemAddendum, provider, model, timeoutMs = DEFAULT_TIMEOUT_MS, agentUser, agentHome, piBin, spawnImpl = spawn } = {}) {
  if (!prompt) throw new Error("pi: no prompt provided");
  const providerName = provider ?? process.env.PI_PROVIDER ?? DEFAULT_PROVIDER;
  const modelId = model ?? process.env.PI_MODEL ?? DEFAULT_MODEL;
  const user = agentUser !== undefined ? agentUser : (process.env.AGENT_USER ?? "botagent");
  const home = agentHome ?? process.env.AGENT_HOME ?? "/var/lib/overcommit";
  const bin = piBin ?? process.env.PI_BIN ?? "pi";

  const piArgs = [...buildPiArgs({ provider: providerName, model: modelId, tools, systemAddendum }), prompt];
  const file = user ? "runuser" : bin;
  const args = user
    ? ["-u", user, "--", "env", `HOME=${home}`, `PI_CODING_AGENT_DIR=${home}/pi-agent`, bin, ...piArgs]
    : piArgs;
  // Minimal environment for the (potentially injected) agent: no bot config,
  // no key paths, nothing but what pi needs to run.
  const spawnEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    PI_CODING_AGENT_DIR: `${home}/pi-agent`,
  };

  return new Promise((resolve, reject) => {
    const child = spawnImpl(file, args, { cwd, env: spawnEnv });
    let out = "";
    let errOut = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi agent timed out after ${timeoutMs}ms${errOut.trim() ? `: ${errOut.trim().slice(-300)}` : ""}`));
    }, timeoutMs);
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (errOut += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`pi agent failed to start (${file}): ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`pi agent exited ${code}: ${(errOut.trim() || out.trim()).slice(-500)}`));
      else if (!out.trim()) reject(new Error("pi agent produced no output"));
      else resolve(out.trim());
    });
  });
}
