import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";

const pem = readFileSync("gh-bot/key.pem", "utf8");
const H = { Accept: "application/vnd.github+json", "User-Agent": "gh-integration-bot" };
const appJwt = jwt.sign({}, pem, { algorithm: "RS256", issuer: process.env.GH_APP_ID, expiresIn: 540 });
const res = await fetch(
  `https://api.github.com/app/installations/${process.env.GH_INSTALLATION_ID}/access_tokens`,
  { method: "POST", headers: { ...H, Authorization: `Bearer ${appJwt}` } },
);
const { token } = await res.json();

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
