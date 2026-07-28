/**
 * The pending half of a Nextcloud SSO login, carried in a signed cookie.
 *
 * **Why not the `state` parameter alone.** When the browser holds no Nextcloud
 * session, NC's `oauth2/authorize` does not redirect back to us — it bounces to its
 * own Login Flow, and drops every query parameter on the way:
 *
 *     GET …/oauth2/authorize?client_id=…&redirect_uri=…&state=f360a3be…
 *      → 303 …/login/flow?providedRedirectUri=&clientIdentifier=…
 *
 * After the sign-in it returns to the registered callback with `state=`, **empty**.
 * A server that looks the pending login up by `state` therefore cannot complete a
 * login from a cookie-less browser at all — found 2026-07-28 in the sibling
 * fleetwatch service, whose Android WebView lost its NC cookie and could never sign
 * in again.
 *
 * So the pending login travels in a cookie of our own. That binds it to the browser
 * that started the login, which is the property `state` was there to prove; `state`
 * is still sent, and still checked whenever NC gives it back. Being self-contained
 * and signed, it also survives the pod restarting mid-login, which the in-memory map
 * in `oauth-state.ts` does not.
 *
 * Scope: **the NC identity login only**. Fitbit's OAuth keeps the in-memory state —
 * it returns `state` faithfully, and its pending entry holds a PKCE `codeVerifier`
 * that has no business in a cookie.
 *
 * Residual risk, accepted deliberately: when NC returns an empty `state` the cookie
 * is the only binding, so a login-CSRF would become possible for someone who can both
 * reach this (VPN-only) host and land a callback in the victim's browser inside the
 * 10-minute window. The alternative is a login that cannot be performed at all.
 */

import * as crypto from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { signValue, verifyValue } from "./session.js";

export const PENDING_COOKIE = "oauth_pending";
/** How long a started login may take to come back. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

export interface PendingLogin {
	/** Echoed to NC as `state`; compared back when NC bothers to return it. */
	nonce: string;
	/** Optional internal path to land on afterwards; allowlist-validated when used. */
	returnTo?: string;
	expiresAt: number;
}

/** `<expiry ms>|<nonce>|<returnTo>` — returnTo last, so a `|` inside a query
 *  string cannot shift the fields. */
function encode(p: PendingLogin): string {
	return `${p.expiresAt}|${p.nonce}|${p.returnTo ?? ""}`;
}

function decode(raw: string): PendingLogin | null {
	const first = raw.indexOf("|");
	const second = raw.indexOf("|", first + 1);
	if (first < 0 || second < 0) return null;
	const expiresAt = Number(raw.slice(0, first));
	if (!Number.isFinite(expiresAt)) return null;
	const returnTo = raw.slice(second + 1);
	return { expiresAt, nonce: raw.slice(first + 1, second), returnTo: returnTo || undefined };
}

/** Start a login: set the cookie, return the nonce to send to NC as `state`. */
export function issuePendingLogin(c: Context, secret: string, returnTo: string | undefined, now: number): string {
	const pending: PendingLogin = {
		nonce: crypto.randomBytes(24).toString("hex"),
		returnTo,
		expiresAt: now + PENDING_TTL_MS,
	};
	setCookie(c, PENDING_COOKIE, signValue(secret, encode(pending)), {
		path: "/",
		httpOnly: true,
		secure: true,
		// Lax, because the callback arrives as a top-level navigation from
		// Nextcloud and a Strict cookie would not be sent with it.
		sameSite: "Lax",
		maxAge: PENDING_TTL_MS / 1000,
	});
	return pending.nonce;
}

/** Finish a login: the pending entry if this callback really belongs to it.
 *
 *  `state` is what NC returned — empty when it was lost through the Login Flow.
 *  Present means it must match; absent means the cookie stands alone. */
export function acceptPendingLogin(
	secret: string,
	cookie: string | undefined,
	state: string | undefined,
	now: number,
): PendingLogin | null {
	if (!cookie) return null;
	const raw = verifyValue(secret, cookie);
	if (!raw) return null;
	const pending = decode(raw);
	if (!pending || pending.expiresAt < now) return null;
	if (state && state !== pending.nonce) return null;
	return pending;
}

/** The login is over: drop its cookie so a stale one can't be replayed. */
export function clearPendingLogin(c: Context): void {
	deleteCookie(c, PENDING_COOKIE, { path: "/" });
}

/** Read the pending cookie off a request. */
export function pendingCookie(c: Context): string | undefined {
	return getCookie(c, PENDING_COOKIE);
}
