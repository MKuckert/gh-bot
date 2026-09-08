// auth.test.mjs — unit tests for the GitHub App auth wrapper (octokit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Octokit } from "octokit";
import { createGitHubAppAuth, createGitHubOctokit } from "./auth.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });
const dir = mkdtempSync(join(tmpdir(), "ghbot-auth-"));
const pemPath = join(dir, "key.pem");
writeFileSync(pemPath, pem, { mode: 0o600 });

function decodeJwt(token) {
  const [h, p] = token.split(".");
  return { header: JSON.parse(Buffer.from(h, "base64url").toString()), payload: JSON.parse(Buffer.from(p, "base64url").toString()) };
}

/** Octokit request function with a mocked fetch — what the strategy expects. */
const mockRequest = (fetchImpl) => new Octokit({ request: { fetch: fetchImpl } }).request;

test("createGitHubAppAuth fails loud on missing credentials", () => {
  assert.throws(() => createGitHubAppAuth({ appId: "", installationId: "1", pemPath }), /GH_APP_ID/);
  assert.throws(() => createGitHubAppAuth({ appId: "1", installationId: "", pemPath }), /GH_INSTALLATION_ID/);
  assert.throws(() => createGitHubAppAuth({ appId: "1", installationId: "1", pemPath: join(dir, "nope.pem") }), /cannot read private key/);
});

test("mints an installation token via a valid app JWT and caches it", async () => {
  let mints = 0;
  const fetchImpl = async (url, init) => {
    assert.match(url, /\/app\/installations\/159479245\/access_tokens$/);
    assert.equal(init.method, "POST");
    const { header, payload } = decodeJwt(init.headers.authorization.replace(/^bearer /i, ""));
    assert.equal(header.alg, "RS256");
    assert.equal(payload.iss, "4843934");
    assert.ok(payload.exp - payload.iat <= 600); // GitHub's 10-minute JWT limit
    mints++;
    return new Response(JSON.stringify({ token: `tok${mints}`, expires_at: new Date(Date.now() + 3600e3).toISOString() }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const auth = createGitHubAppAuth({ appId: "4843934", installationId: "159479245", pemPath, request: mockRequest(fetchImpl) });
  const first = await auth({ type: "installation" });
  assert.equal(first.token, "tok1");
  const second = await auth({ type: "installation" });
  assert.equal(second.token, "tok1"); // cached — no second mint
  assert.equal(mints, 1);
});

test("octokit retries after a 401 (token replication delay) and reuses the token", async () => {
  let mints = 0;
  let apiCalls = 0;
  const fetchImpl = async (url, init) => {
    if (url.includes("/access_tokens")) {
      mints++;
      return new Response(JSON.stringify({ token: `tok${mints}`, expires_at: new Date(Date.now() + 3600e3).toISOString() }), { status: 201, headers: { "content-type": "application/json" } });
    }
    apiCalls++;
    if (apiCalls === 1) {
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify([{ number: 7, title: "hi" }]), { status: 200, headers: { "content-type": "application/json" } });
  };
  // distinct installationId: the strategy cache is module-level and keyed by it
  const octokit = createGitHubOctokit({ appId: "4843934", installationId: "999999999", pemPath, request: { fetch: fetchImpl } });
  const issues = await octokit.rest.issues.listForRepo({ owner: "MKuckert", repo: "env", state: "open" });
  assert.equal(issues.data.length, 1);
  assert.equal(apiCalls, 2); // 401 → retry with the same (fresh) token
  assert.equal(mints, 1); // no re-mint — a fast 401 is treated as replication delay
});
