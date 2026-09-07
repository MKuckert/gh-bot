// auth.mjs — GitHub App authentication via @octokit/auth-app.
// The strategy handles the whole dance: RS256 JWT minting, installation-token
// exchange, caching, and re-auth on 401. This module validates inputs (fail
// loud) and exposes:
//   createGitHubAppAuth  — the auth strategy (direct token minting; CLI, tests)
//   createGitHubOctokit  — an Octokit wired with the strategy (bot round)

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Validates credentials and resolves the private key (fail loud). */
function resolveCredentials({ appId, installationId, pemPath }) {
  if (!appId) throw new Error("GH_APP_ID is missing");
  if (!installationId) throw new Error("GH_INSTALLATION_ID is missing");
  let privateKey;
  try {
    privateKey = readFileSync(pemPath, "utf8");
  } catch (err) {
    throw new Error(`cannot read private key at ${pemPath}: ${err.message}`);
  }
  return { appId: String(appId), privateKey, installationId: String(installationId) };
}

/**
 * @param {object} opts
 * @param {string|number} opts.appId          GitHub App ID (numeric) — the JWT `iss`
 * @param {string|number} opts.installationId installation on the target repo
 * @param {string}        opts.pemPath        path to the app private key PEM
 * @param {object}        [opts.request]      injectable request (tests)
 * @returns {import("@octokit/auth-app").AppAuthStrategyInstance}
 */
export function createGitHubAppAuth({ appId, installationId, pemPath, request }) {
  // spread conditionally: an explicit `request: undefined` would clobber the strategy default
  return createAppAuth({ ...resolveCredentials({ appId, installationId, pemPath }), ...(request ? { request } : {}) });
}

/** Octokit instance that transparently mints/caches installation tokens. */
export function createGitHubOctokit({ appId, installationId, pemPath, request }) {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: resolveCredentials({ appId, installationId, pemPath }),
    ...(request ? { request } : {}),
  });
}

// --- CLI (only when executed directly) --------------------------------------
// node src/auth.mjs --token  → prints a fresh installation token to stdout,
// expiry to stderr. Needs GH_APP_ID, GH_INSTALLATION_ID and KEY_PATH in env
// (lib/env.sh provides all three; token.sh is the shell wrapper).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "--token") {
    console.error("usage: node src/auth.mjs --token");
    process.exit(2);
  }
  try {
    const auth = createGitHubAppAuth({
      appId: process.env.GH_APP_ID,
      installationId: process.env.GH_INSTALLATION_ID,
      pemPath: process.env.KEY_PATH,
    });
    const { token, expiresAt } = await auth({ type: "installation" });
    console.error(`auth: valid until ${new Date(expiresAt).toISOString()}`);
    console.log(token);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
