/**
 * Google OAuth 2.0 — exchange a stored refresh token for an access token.
 *
 * Part of the Fitbit Web API → Google Health API migration (#260). The
 * legacy Fitbit Web API shuts down Sep 2026; weight already only exists on
 * the Google side (Hume scale → Health Connect → Google Health). The
 * refresh token is obtained once via user consent (see scripts/ghealth-spike)
 * and stored as a secret; this mints short-lived access tokens server-side,
 * no phone in the loop.
 */

export interface GoogleCreds {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}

/** Read Google OAuth creds from the environment, or null if not configured. */
export function googleCredsFromEnv(): GoogleCreds | null {
	const clientId = process.env.GH_CLIENT_ID;
	const clientSecret = process.env.GH_CLIENT_SECRET;
	const refreshToken = process.env.GH_REFRESH_TOKEN;
	if (!clientId || !clientSecret || !refreshToken) return null;
	return { clientId, clientSecret, refreshToken };
}

interface TokenResponse {
	access_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

/** Exchange the refresh token for a fresh access token. */
export async function googleAccessToken(creds: GoogleCreds): Promise<string> {
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: creds.clientId,
			client_secret: creds.clientSecret,
			grant_type: "refresh_token",
			refresh_token: creds.refreshToken,
		}),
	});
	const json = (await res.json()) as TokenResponse;
	if (!res.ok || !json.access_token) {
		throw new Error(`google token ${res.status}: ${json.error ?? ""} ${json.error_description ?? ""}`.trim());
	}
	return json.access_token;
}
