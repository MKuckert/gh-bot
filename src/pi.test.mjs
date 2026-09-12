// pi.test.mjs — headless agent runner: argv construction, isolation, failure modes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildPiArgs, runPiAgent } from "./pi.mjs";

test("buildPiArgs: non-interactive, strict tool allowlist, system addendum, prompt after --", () => {
  const args = buildPiArgs({ provider: "omlx", model: "m1", tools: ["read"], systemAddendum: "sec" });
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("--no-session"));
  assert.deepEqual(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 2), ["--provider", "omlx"]);
  assert.equal(args[args.indexOf("--tools") + 1], "read");
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], "sec");
  assert.equal(args.at(-1), "--");
});

function fakeSpawn({ code = 0, out = "done", errOut = "" } = {}) {
  const calls = [];
  const impl = (file, args, opts) => {
    calls.push({ file, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (out) child.stdout.emit("data", Buffer.from(out));
      if (errOut) child.stderr.emit("data", Buffer.from(errOut));
      child.emit("close", code);
    });
    return child;
  };
  return { calls, impl };
}

test("agent runs as the unprivileged user via runuser with isolated HOME/PI_CODING_AGENT_DIR", async () => {
  const sp = fakeSpawn();
  await runPiAgent({
    prompt: "hi", cwd: "/tmp/w", tools: ["read"],
    agentUser: "botagent", agentHome: "/var/lib/overcommit", piBin: "/opt/pi", spawnImpl: sp.impl,
  });
  const { file, args } = sp.calls[0];
  assert.equal(file, "runuser");
  assert.equal(args[args.indexOf("-u") + 1], "botagent");
  const envIdx = args.indexOf("env");
  assert.equal(args[envIdx + 1], "HOME=/var/lib/overcommit");
  assert.equal(args[envIdx + 2], "PI_CODING_AGENT_DIR=/var/lib/overcommit/pi-agent");
  assert.equal(args[envIdx + 3], "/opt/pi");
  // the agent gets a minimal env — no bot config leaks into it
  assert.equal(sp.calls[0].opts.env.GH_APP_ID, undefined);
  assert.ok(sp.calls[0].opts.env.PATH);
  assert.equal(sp.calls[0].opts.env.PI_CODING_AGENT_DIR, "/var/lib/overcommit/pi-agent");
});

test("resolves with stdout on exit 0; rejects on non-zero or empty output", async () => {
  assert.equal(await runPiAgent({ prompt: "x", cwd: ".", agentUser: "", spawnImpl: fakeSpawn().impl }), "done");
  const bad = fakeSpawn({ code: 1, out: "", errOut: "boom" });
  await assert.rejects(runPiAgent({ prompt: "x", cwd: ".", agentUser: "", spawnImpl: bad.impl }), /exited 1/);
  const empty = fakeSpawn({ code: 0, out: "" });
  await assert.rejects(runPiAgent({ prompt: "x", cwd: ".", agentUser: "", spawnImpl: empty.impl }), /no output/);
});

test("throws when the prompt is missing", async () => {
  assert.throws(() => runPiAgent({ cwd: ".", agentUser: "", spawnImpl: fakeSpawn().impl }), /no prompt/);
});
