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
// ⚠ ALL THREE, IN ONE CONSENT. Measured 2026-08-27 (#260): with only the first,
// eight data types answer 403 `MISSING_OAUTH_SCOPE` — steps, sleep, distance,
// altitude, active-minutes, active-zone-minutes, active-energy-burned and
// time-in-heart-rate-zone. Seven of the eight want one scope.
//
// The consent is one-off and the token does not carry scopes it was not granted,
// so a list that is short here costs a SECOND trip through the consent screen.
//
// ⚠ The names come from the v4 reference, not from the shape of the first one.
// Google's 403 reports them as `activity_and_fitness_readonly`; the scope URL
// spells it `activity_and_fitness.readonly` — a dot, not an underscore, before
// `readonly`. Guessing that from the error string alone gets an invalid_scope.
const SCOPES = [
	"https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
	"https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
	"https://www.googleapis.com/auth/googlehealth.sleep.readonly",
];
const SCOPE = SCOPES.join(" ");
const PORT = 8765;
const REDIRECT = `http://127.0.0.1:${PORT}/`;

if (!CLIENT_ID) {
	console.error("Set GH_CLIENT_ID.");
	process.exit(2);
}

// ⚠ REFUSE BEFORE THE CONSENT, NOT AFTER IT.
//
// The header says the secret is optional because PKCE works with a public
// client. THIS client is confidential. Measured 2026-08-27: without it the run
// prints a URL, the consent is approved, the redirect is caught — and only then
// does the token endpoint answer
//
//     400 {"error":"invalid_request","error_description":"client_secret is missing."}
//
// by which point a real consent has been spent for nothing. The cost is only a
// re-approval, but the failure lands after the one step a human had to do, which
// is the worst place to put it.
//
// GH_REFRESH_TOKEN is the exception: that path never reaches the code exchange.
if (!CLIENT_SECRET && !process.env.GH_REFRESH_TOKEN) {
	console.error(
		"Set GH_CLIENT_SECRET. This client is confidential — without it the consent\n" +
			"screen is shown, approved, and THEN the token exchange fails, wasting the\n" +
			"approval. Refusing now instead.\n\n" +
			"  export GH_CLIENT_SECRET=$(ssh root@isis kubectl get secret health-google \\\n" +
			"    -n health -o jsonpath='{.data.GH_CLIENT_SECRET}' | base64 -d)",
	);
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

// ⚠ PROBE A NEWLY GRANTED SCOPE, not `weight`. Weight worked before this change
// and would answer 200 whether or not the new scopes were granted — a check that
// passes for the wrong reason. `sleep` is behind `sleep.readonly`, so a 200 here
// means the consent actually widened; a 403 means it did not, whatever the
// consent screen appeared to say.
const checks = [
	["sleep", "sleep.readonly"],
	["steps", "activity_and_fitness.readonly"],
	["weight", "health_metrics_and_measurements.readonly (the control)"],
];
let bad = 0;
for (const [type, why] of checks) {
	const url = `https://health.googleapis.com/v4/users/me/dataTypes/${type}/dataPoints?pageSize=1`;
	const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
	const ok = res.ok;
	if (!ok) bad++;
	console.log(`${ok ? "OK  " : "FAIL"} ${type.padEnd(8)} HTTP ${res.status}   (${why})`);
	if (!ok) console.log(`      ${(await res.text()).slice(0, 300)}`);
}
console.log(bad === 0 ? "\nAll three scopes are live." : `\n${bad} still refused — the consent did not widen.`);
process.exit(bad === 0 ? 0 : 1);
