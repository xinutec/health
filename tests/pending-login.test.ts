import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
	acceptPendingLogin,
	issuePendingLogin,
	PENDING_COOKIE,
	PENDING_TTL_MS,
} from "../src/middleware/pending-login.js";

const SECRET = "test-session-secret-0123456789abcdef";

/** Run `issuePendingLogin` through a real request and hand back both halves:
 *  the nonce we sent NC, and the cookie the browser would hold. */
async function startLogin(returnTo?: string, now = Date.now()) {
	let nonce = "";
	const app = new Hono();
	app.get("/login", (c) => {
		nonce = issuePendingLogin(c, SECRET, returnTo, now);
		return c.text("ok");
	});
	const res = await app.request("/login");
	const setCookie = res.headers.get("set-cookie") ?? "";
	const cookie = setCookie.split(";")[0].slice(`${PENDING_COOKIE}=`.length);
	return { nonce, cookie: decodeURIComponent(cookie) };
}

describe("pending login cookie", () => {
	it("completes when Nextcloud echoes the state", async () => {
		const now = Date.now();
		const { nonce, cookie } = await startLogin("/your-day", now);
		const pending = acceptPendingLogin(SECRET, cookie, nonce, now);
		expect(pending?.returnTo).toBe("/your-day");
	});

	it("completes when the Login Flow swallowed the state", async () => {
		// NC redirects to /auth/callback?state=&code=… when the browser had no NC
		// session. This is the bug: it used to be unrecoverable.
		const now = Date.now();
		const { cookie } = await startLogin("/your-day", now);
		expect(acceptPendingLogin(SECRET, cookie, "", now)).not.toBeNull();
		expect(acceptPendingLogin(SECRET, cookie, undefined, now)).not.toBeNull();
	});

	it("refuses a state that does not match", async () => {
		const now = Date.now();
		const { cookie } = await startLogin(undefined, now);
		const other = await startLogin(undefined, now);
		expect(acceptPendingLogin(SECRET, cookie, other.nonce, now)).toBeNull();
	});

	it("refuses a callback with no cookie", async () => {
		const now = Date.now();
		const { nonce } = await startLogin(undefined, now);
		expect(acceptPendingLogin(SECRET, undefined, nonce, now)).toBeNull();
	});

	it("refuses a forged or tampered cookie", async () => {
		const now = Date.now();
		const { nonce, cookie } = await startLogin(undefined, now);
		expect(acceptPendingLogin("other-secret", cookie, nonce, now)).toBeNull();
		const tampered = cookie.replace(nonce, "f".repeat(nonce.length));
		expect(acceptPendingLogin(SECRET, tampered, undefined, now)).toBeNull();
		expect(acceptPendingLogin(SECRET, "not-a-cookie", undefined, now)).toBeNull();
	});

	it("refuses a login left open too long", async () => {
		const now = Date.now();
		const { nonce, cookie } = await startLogin(undefined, now);
		expect(acceptPendingLogin(SECRET, cookie, nonce, now + PENDING_TTL_MS)).not.toBeNull();
		expect(acceptPendingLogin(SECRET, cookie, nonce, now + PENDING_TTL_MS + 1)).toBeNull();
	});

	it("survives a returnTo containing the field separator", async () => {
		const now = Date.now();
		const { nonce, cookie } = await startLogin("/your-day?q=a|b", now);
		expect(acceptPendingLogin(SECRET, cookie, nonce, now)?.returnTo).toBe("/your-day?q=a|b");
	});

	it("round-trips an absent returnTo as undefined", async () => {
		const now = Date.now();
		const { nonce, cookie } = await startLogin(undefined, now);
		expect(acceptPendingLogin(SECRET, cookie, nonce, now)?.returnTo).toBeUndefined();
	});
});
