// auth.mjs — GitHub App JWT minting + installation token management.
// Fail-loud: missing credentials throw with an explicit message; no silent fallbacks.

import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";

export const JWT_TTL_SECONDS = 540; // GitHub rejects exp > 10 min

export function mintJwt(pem, appId) {
  return jwt.sign({}, pem, { algorithm: "RS256", issuer: String(appId), expiresIn: JWT_TTL_SECONDS });
}

/**
 * Mints installation access tokens for one app installation.
 * Tokens are cached in memory and reused until ~5 min before expiry; a 401
 * forces one re-mint and retry (handled by `request`).
 */
export class AppAuth {
  /**
   * @param {object} opts
   * @param {string|number} opts.appId          GitHub App ID (numeric) — the JWT `iss`
   * @param {string|number} opts.installationId installation on the target repo
   * @param {string}        opts.pemPath        path to the app private key PEM
   * @param {string}        [opts.apiBase]      default https://api.github.com
   * @param {typeof fetch}  [opts.fetchImpl]    injectable for tests
   */
  constructor({ appId, installationId, pemPath, apiBase = "https://api.github.com", fetchImpl = fetch }) {
    if (!appId) throw new Error("AppAuth: GH_APP_ID is missing");
    if (!installationId) throw new Error("AppAuth: GH_INSTALLATION_ID is missing");
    if (!pemPath) throw new Error("AppAuth: key path is missing");
    let pem;
    try {
      pem = readFileSync(pemPath, "utf8");
    } catch (err) {
      throw new Error(`AppAuth: cannot read private key at ${pemPath}: ${err.message}`);
    }
    this.pem = pem;
    this.appId = String(appId);
    this.installationId = String(installationId);
    this.apiBase = apiBase.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    /** @type {{token: string, expiresAt: number} | null} */
    this.cached = null;
  }

  async getToken() {
    const now = Date.now() / 1000;
    if (this.cached && this.cached.expiresAt - now > 300) return this.cached.token;
    const appJwt = mintJwt(this.pem, this.appId);
    const res = await this.fetchImpl(
      `${this.apiBase}/app/installations/${this.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "overcommit-bot",
        },
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`AppAuth: token mint failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
    }
    const { token, expires_at } = await res.json();
    this.cached = { token, expiresAt: new Date(expires_at).getTime() / 1000 };
    return token;
  }

  /**
   * Authenticated REST request. On 401: re-mint once and retry; a second 401
   * aborts with a clear error. Non-2xx responses throw (fail loud).
   */
  async request(path, { method = "GET", body } = {}) {
    const doFetch = async (token) =>
      this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "overcommit-bot",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

    let res = await doFetch(await this.getToken());
    if (res.status === 401) {
      this.cached = null; // force re-mint
      res = await doFetch(await this.getToken());
      if (res.status === 401) {
        const text = await res.text();
        throw new Error(`AppAuth: still 401 after re-mint on ${method} ${path}: ${text.slice(0, 300)}`);
      }
    }
    if (!res.ok) {
      const text = await res.text();
      const reset = res.headers.get("x-ratelimit-reset");
      throw new Error(
        `GitHub API ${method} ${path} failed (HTTP ${res.status})${reset ? `, rate-limit reset at epoch ${reset}` : ""}: ${text.slice(0, 300)}`,
      );
    }
    return res.json();
  }
}
