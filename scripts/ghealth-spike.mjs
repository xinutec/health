// Google Health API spike — OAuth (loopback + PKCE) + fetch weight data points.
//
// Goal: confirm the weight stuck on Google's side (e.g. 68.3 kg logged
// 2026-06-19, invisible to the legacy Fitbit Web API) is reachable
// server-to-server via https://health.googleapis.com — de-risking the
// Fitbit Web API -> Google Health API migration (task #260).
//
// PKCE flow: works with a "public" OAuth client (no client secret). If the
// client IS confidential, set GH_CLIENT_SECRET and it'll be included too.
//
// Usage (from the health repo root, on a machine with a browser):
//   export GH_CLIENT_ID=...                # OAuth client id (required)
//   export GH_CLIENT_SECRET=...            # only if a confidential client
//   node scripts/ghealth-spike.mjs         # first run: prints consent URL, then weight
//   export GH_REFRESH_TOKEN=...            # paste the printed token to skip OAuth later
//   node scripts/ghealth-spike.mjs

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

const CLIENT_ID = process.env.GH_CLIENT_ID;
const CLIENT_SECRET = process.env.GH_CLIENT_SECRET; // optional (PKCE public client)
const SCOPE = "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly";
const PORT = 8765;
const REDIRECT = `http://127.0.0.1:${PORT}/`;

if (!CLIENT_ID) {
	console.error("Set GH_CLIENT_ID.");
	process.exit(2);
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function tokenRequest(params) {
	if (CLIENT_SECRET) params.client_secret = CLIENT_SECRET;
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params),
	});
	const json = await res.json();
	if (!res.ok) throw new Error(`token endpoint ${res.status}: ${JSON.stringify(json)}`);
	return json;
}

async function getAccessToken() {
	if (process.env.GH_REFRESH_TOKEN) {
		const t = await tokenRequest({
			client_id: CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: process.env.GH_REFRESH_TOKEN,
		});
		return t.access_token;
	}

	const verifier = b64url(randomBytes(48));
	const challenge = b64url(createHash("sha256").update(verifier).digest());

	const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	authUrl.searchParams.set("client_id", CLIENT_ID);
	authUrl.searchParams.set("redirect_uri", REDIRECT);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("scope", SCOPE);
	authUrl.searchParams.set("access_type", "offline");
	authUrl.searchParams.set("prompt", "consent");
	authUrl.searchParams.set("code_challenge", challenge);
	authUrl.searchParams.set("code_challenge_method", "S256");

	const code = await new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const u = new URL(req.url, REDIRECT);
			const c = u.searchParams.get("code");
			const e = u.searchParams.get("error");
			res.end(c ? "Got it — close this tab and return." : `OAuth error: ${e}`);
			server.close();
			if (c) resolve(c);
			else reject(new Error(`OAuth error: ${e}`));
		});
		server.listen(PORT, "127.0.0.1", () => {
			console.log("\n=== OPEN THIS URL IN YOUR BROWSER AND APPROVE ===\n");
			console.log(authUrl.toString());
			console.log("\n=== waiting for the redirect on 127.0.0.1:8765 ===\n");
		});
	});

	const t = await tokenRequest({
		client_id: CLIENT_ID,
		grant_type: "authorization_code",
		code,
		redirect_uri: REDIRECT,
		code_verifier: verifier,
	});
	if (t.refresh_token) {
		console.log(`\n[refresh_token] ${t.refresh_token}\n`);
	}
	return t.access_token;
}

const accessToken = await getAccessToken();

const url = "https://health.googleapis.com/v4/users/me/dataTypes/weight/dataPoints?pageSize=50";
const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
const body = await res.text();
console.log(`\nGET ${url}\n-> HTTP ${res.status}\n`);
console.log(body.slice(0, 6000));
process.exit(res.ok ? 0 : 1);
