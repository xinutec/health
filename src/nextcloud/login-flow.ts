/**
 * Nextcloud Login Flow v2 client.
 *
 * https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/index.html
 *
 * Three-step protocol used by DAVx⁵, KDE Connect, the official NC
 * mobile apps, and now this dashboard:
 *
 *   1. POST {baseUrl}/index.php/login/v2
 *      → { poll: { token, endpoint }, login }
 *
 *   2. Open `login` URL in the user's browser; user signs in (if
 *      not already) and clicks "Grant access". Nextcloud creates
 *      a per-device "app password" — a long random token bound to
 *      this one device.
 *
 *   3. Poll `poll.endpoint` with `{ token: poll.token }`:
 *      - 404 while the user hasn't granted yet
 *      - 200 with { server, loginName, appPassword } once they have
 *
 * The app then uses HTTP Basic Auth (`base64(loginName:appPassword)`)
 * on every NC API call — no expiry, no refresh, single-credential.
 *
 * This module is the protocol layer. Route handlers in api.ts
 * orchestrate the user-facing flow (initiate, return loginUrl to
 * the SPA, poll until ready, persist).
 */

export interface LoginFlowInitiation {
	/** URL the user opens in a browser to grant access. */
	loginUrl: string;
	/** POST endpoint the app polls for completion. */
	pollEndpoint: string;
	/** Token the poll endpoint requires to identify this flow. */
	pollToken: string;
}

export interface LoginFlowResult {
	/** Nextcloud server URL (matches the `baseUrl` the flow was
	 *  initiated against; included as a sanity check). */
	server: string;
	/** NC username the granted app password is bound to. */
	loginName: string;
	/** Long random token; used with HTTP Basic Auth from now on. */
	appPassword: string;
}

/** Parse the response from `POST /index.php/login/v2`. */
export function parseInitiateResponse(json: unknown): LoginFlowInitiation {
	if (!json || typeof json !== "object") {
		throw new Error("login-flow initiate: response is not an object");
	}
	const obj = json as Record<string, unknown>;
	const poll = obj.poll;
	const login = obj.login;
	if (!poll || typeof poll !== "object") {
		throw new Error("login-flow initiate: missing `poll`");
	}
	const pollObj = poll as Record<string, unknown>;
	const token = pollObj.token;
	const endpoint = pollObj.endpoint;
	if (typeof login !== "string" || login.length === 0) {
		throw new Error("login-flow initiate: missing/invalid `login` URL");
	}
	if (typeof token !== "string" || token.length === 0) {
		throw new Error("login-flow initiate: missing/invalid `poll.token`");
	}
	if (typeof endpoint !== "string" || endpoint.length === 0) {
		throw new Error("login-flow initiate: missing/invalid `poll.endpoint`");
	}
	return { loginUrl: login, pollEndpoint: endpoint, pollToken: token };
}

/** Parse the 200-response body from the poll endpoint (the
 *  "completed" payload). The 404-pending case never reaches this
 *  function — the caller checks the status code first. */
export function parsePollResponse(json: unknown): LoginFlowResult {
	if (!json || typeof json !== "object") {
		throw new Error("login-flow poll: response is not an object");
	}
	const obj = json as Record<string, unknown>;
	const server = obj.server;
	const loginName = obj.loginName;
	const appPassword = obj.appPassword;
	if (typeof server !== "string" || server.length === 0) {
		throw new Error("login-flow poll: missing `server`");
	}
	if (typeof loginName !== "string" || loginName.length === 0) {
		throw new Error("login-flow poll: missing `loginName`");
	}
	if (typeof appPassword !== "string" || appPassword.length === 0) {
		throw new Error("login-flow poll: missing `appPassword`");
	}
	return { server, loginName, appPassword };
}

/** Build the HTTP Basic Auth header value for a (loginName, appPassword)
 *  pair. Per RFC 7617: `Basic <base64(loginName:appPassword)>` using
 *  UTF-8 byte encoding for non-ASCII chars. */
export function basicAuthHeader(loginName: string, appPassword: string): string {
	const credentials = `${loginName}:${appPassword}`;
	const encoded = Buffer.from(credentials, "utf-8").toString("base64");
	return `Basic ${encoded}`;
}

export interface PollOptions {
	/** Delay between successive polls. NC's docs suggest ≥ 2s; for
	 *  tests we typically pass 100ms with fake timers. */
	intervalMs: number;
	/** Give up after this long. */
	deadlineMs: number;
	/** Injectable fetch for tests. Defaults to global `fetch`. */
	fetchImpl?: typeof fetch;
}

/**
 * Poll the NC login-flow poll endpoint until the user has granted
 * access or the deadline elapses. Each iteration POSTs
 * `token=<pollToken>` as form data. A 404 means "not yet"; a 200
 * carries the credentials. Anything else throws.
 *
 * Resolves with the credentials on success; rejects with a deadline
 * error on timeout.
 */
export async function pollLoginFlow(state: LoginFlowInitiation, options: PollOptions): Promise<LoginFlowResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const deadline = Date.now() + options.deadlineMs;

	while (true) {
		const res = await fetchImpl(state.pollEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token: state.pollToken }).toString(),
		});

		if (res.status === 200) {
			const json = (await res.json()) as unknown;
			return parsePollResponse(json);
		}
		// 404 is the documented "pending" code. Anything else is an
		// error worth surfacing.
		if (res.status !== 404) {
			throw new Error(`login-flow poll: unexpected status ${res.status}`);
		}

		if (Date.now() + options.intervalMs > deadline) {
			throw new Error(`login-flow poll: deadline (${options.deadlineMs}ms) reached without completion`);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, options.intervalMs));
	}
}
