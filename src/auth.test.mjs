// auth.test.mjs — unit tests for JWT minting, token caching, 401 re-mint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { AppAuth, mintJwt, JWT_TTL_SECONDS } from "./auth.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });
const dir = mkdtempSync(join(tmpdir(), "ghbot-auth-"));
const pemPath = join(dir, "key.pem");
writeFileSync(pemPath, pem, { mode: 0o600 });

function decode(token) {
  const [h, p] = token.split(".");
  return { header: JSON.parse(Buffer.from(h, "base64url").toString()), payload: JSON.parse(Buffer.from(p, "base64url").toString()) };
}

test("mintJwt: RS256, numeric-string iss, exp within GitHub's 10-min limit", () => {
  const token = mintJwt(pem, 4843934);
  const { header, payload } = decode(token);
  assert.equal(header.alg, "RS256");
  assert.equal(payload.iss, "4843934");
  assert.ok(payload.exp - payload.iat <= JWT_TTL_SECONDS);
  // signature actually verifies against the public key
  jwt.verify(token, publicKey);
});

test("constructor fails loud on missing credentials", () => {
  assert.throws(() => new AppAuth({ appId: "", installationId: "1", pemPath }), /GH_APP_ID/);
  assert.throws(() => new AppAuth({ appId: "1", installationId: "", pemPath }), /GH_INSTALLATION_ID/);
  assert.throws(() => new AppAuth({ appId: "1", installationId: "1", pemPath: join(dir, "nope.pem") }), /cannot read private key/);
});

test("getToken: mints via POST with a valid JWT and caches until ~5 min before expiry", async () => {
  let mints = 0;
  const fetchImpl = async (url, opts) => {
    assert.match(url, /\/app\/installations\/159479245\/access_tokens$/);
    assert.equal(opts.method, "POST");
    const { payload } = decode(opts.headers.Authorization.replace("Bearer ", ""));
    assert.equal(payload.iss, "4843934");
    mints++;
    return { ok: true, json: async () => ({ token: `tok${mints}`, expires_at: new Date(Date.now() + 3600e3).toISOString() }) };
  };
  const auth = new AppAuth({ appId: "4843934", installationId: "159479245", pemPath, fetchImpl });
  assert.equal(await auth.getToken(), "tok1");
  assert.equal(await auth.getToken(), "tok1"); // cached — no second mint
  assert.equal(mints, 1);

  auth.cached = { token: "old", expiresAt: Date.now() / 1000 + 200 }; // < 5 min left
  assert.equal(await auth.getToken(), "tok2");
  assert.equal(mints, 2);
});

test("request: retries once after 401 with a fresh token", async () => {
  let mints = 0;
  let userCalls = 0;
  const fetchImpl = async (url, opts) => {
    if (opts.method === "POST") {
      mints++;
      return { ok: true, json: async () => ({ token: `tok${mints}`, expires_at: new Date(Date.now() + 3600e3).toISOString() }) };
    }
    userCalls++;
    if (userCalls === 1) return { ok: false, status: 401, text: async () => "Bad credentials" };
    return { ok: true, json: async () => ({ login: "overcommit-bot[bot]" }) };
  };
  const auth = new AppAuth({ appId: "4843934", installationId: "159479245", pemPath, fetchImpl });
  const me = await auth.request("/user");
  assert.equal(me.login, "overcommit-bot[bot]");
  assert.equal(mints, 2); // initial mint + one re-mint after 401
  assert.equal(userCalls, 2); // original attempt + retry
});

test("request: aborts with clear error on persistent 401", async () => {
  let mints = 0;
  const fetchImpl = async (url, opts) => {
    if (opts.method === "POST") {
      mints++;
      return { ok: true, json: async () => ({ token: `t${mints}`, expires_at: new Date(Date.now() + 3600e3).toISOString() }) };
    }
    return { ok: false, status: 401, text: async () => "Bad credentials" };
  };
  const auth = new AppAuth({ appId: "4843934", installationId: "159479245", pemPath, fetchImpl });
  await assert.rejects(() => auth.request("/user"), /still 401 after re-mint/);
});

test("request: surfaces non-2xx errors with status and body", async () => {
  const fetchImpl = async (url, opts) => {
    if (opts.method === "POST") return { ok: true, json: async () => ({ token: "t", expires_at: new Date(Date.now() + 3600e3).toISOString() }) };
    return { ok: false, status: 403, headers: new Map(), text: async () => "Resource not accessible by integration" };
  };
  const auth = new AppAuth({ appId: "4843934", installationId: "159479245", pemPath, fetchImpl });
  await assert.rejects(() => auth.request("/user"), /HTTP 403.*Resource not accessible/);
});
