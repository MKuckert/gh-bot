// verify-auth.mjs — live end-to-end auth check (token mint, repos, issue read).
// No side effects. Needs GH_APP_ID, GH_INSTALLATION_ID in env and key.pem at repo root.
import { createGitHubAppAuth } from "./auth.mjs";

const auth = createGitHubAppAuth({
  appId: process.env.GH_APP_ID,
  installationId: process.env.GH_INSTALLATION_ID,
  pemPath: "key.pem",
});

const { token, expiresAt } = await auth({ type: "installation" });
console.log(`token minted: ${token.slice(0, 10)}… valid until ${new Date(expiresAt).toISOString()}`);

const H = { Accept: "application/vnd.github+json", "User-Agent": "gh-integration-bot" };
for (const path of ["/installation/repositories", "/repos/MKuckert/env/issues?state=open&per_page=100"]) {
  const r = await fetch(`https://api.github.com${path}`, { headers: { ...H, Authorization: `Bearer ${token}` } });
  const body = await r.text();
  if (!r.ok) { console.log(`${path}: HTTP ${r.status} — ${body.slice(0, 200)}`); continue; }
  const json = JSON.parse(body);
  if (Array.isArray(json)) {
    console.log(`${path}: ${json.length} items`);
    for (const i of json.slice(0, 12)) console.log(`  #${i.number ?? ""} ${i.title ?? i.full_name}`);
  } else {
    console.log(`${path}: repos = ${json.items?.map(x => x.full_name).join(", ")}`);
  }
}
