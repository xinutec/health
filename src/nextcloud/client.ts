/**
 * Thin Nextcloud HTTP client. Uses an app password (obtained via
 * Login Flow v2; see `login-flow.ts`) and sends HTTP Basic Auth on
 * every request — no token expiry, no refresh dance.
 *
 * Stateless apart from holding the userId; credentials are read from
 * `nc_credentials` on each request. Cache layers higher up (e.g.
 * velocity-cache) keep this cheap.
 *
 * A 401 from NC signals the user revoked the app password from NC's
 * Security settings (or it was otherwise invalidated). We flag the
 * row `needs_reauth` so /api/me surfaces it to the SPA, and throw
 * `NextcloudReauthRequiredError`.
 */

import { getCredentials, markNeedsReauth, NextcloudReauthRequiredError } from "./credentials.js";
import { basicAuthHeader } from "./login-flow.js";

export { NextcloudNotLinkedError, NextcloudReauthRequiredError } from "./credentials.js";

/** Configuration the client needs (just the NC base URL — the
 *  credentials are loaded per-user from `nc_credentials`). */
export interface NextcloudConfig {
	baseUrl: string;
}

export class NextcloudClient {
	constructor(
		private readonly userId: string,
		private readonly config: NextcloudConfig,
	) {}

	async get<T>(path: string): Promise<T> {
		return this.request<T>("GET", path);
	}

	async put<T>(path: string, body: unknown): Promise<T> {
		return this.request<T>("PUT", path, body);
	}

	async post<T>(path: string, body: unknown): Promise<T> {
		return this.request<T>("POST", path, body);
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const creds = await getCredentials(this.userId);

		const url = path.startsWith("http") ? path : `${this.config.baseUrl}${path}`;
		const headers: Record<string, string> = {
			Authorization: basicAuthHeader(creds.loginName, creds.appPassword),
			"OCS-APIRequest": "true",
		};
		const init: RequestInit = { method, headers };
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(body);
		}

		const res = await fetch(url, init);
		if (res.status === 401) {
			// App password was revoked or NC's user db says no.
			// Persistent state, not retryable.
			await markNeedsReauth(this.userId);
			throw new NextcloudReauthRequiredError();
		}
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Nextcloud API ${method} ${path}: ${res.status} ${text}`);
		}

		// Some PhoneTrack endpoints return empty body — guard against that.
		const text = await res.text();
		return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
	}
}
