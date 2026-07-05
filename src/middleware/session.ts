import * as crypto from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { db } from "../db/pool.js";
import type { AppEnv } from "../env.js";
import type { UserSession } from "../types.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = "session";

export async function createSession(secret: string, user: UserSession): Promise<string> {
	const id = crypto.randomBytes(32).toString("hex");
	await db()
		.insertInto("sessions")
		.values({
			id,
			user_id: user.userId,
			display_name: user.displayName,
			expires_at: new Date(Date.now() + SESSION_TTL_MS),
		})
		.execute();
	return signValue(secret, id);
}

export async function destroySession(secret: string, signedId: string): Promise<void> {
	const id = verifyValue(secret, signedId);
	if (id) {
		await db().deleteFrom("sessions").where("id", "=", id).execute();
	}
}

export async function getSession(secret: string, signedId: string): Promise<UserSession | null> {
	const id = verifyValue(secret, signedId);
	if (!id) return null;

	const row = await db()
		.selectFrom("sessions")
		.select(["user_id", "display_name", "expires_at"])
		.where("id", "=", id)
		.executeTakeFirst();

	if (!row) return null;
	if (new Date(row.expires_at) < new Date()) {
		await db().deleteFrom("sessions").where("id", "=", id).execute();
		return null;
	}

	return { userId: row.user_id, displayName: row.display_name };
}

export function signValue(secret: string, value: string): string {
	const sig = crypto.createHmac("sha256", secret).update(value).digest("base64url");
	return `${value}.${sig}`;
}

export function verifyValue(secret: string, signed: string): string | null {
	const idx = signed.lastIndexOf(".");
	if (idx < 0) return null;
	const value = signed.slice(0, idx);
	const sig = signed.slice(idx + 1);
	const sigBuf = Buffer.from(sig, "utf-8");
	const expectedBuf = Buffer.from(crypto.createHmac("sha256", secret).update(value).digest("base64url"), "utf-8");
	if (sigBuf.length !== expectedBuf.length) return null;
	if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
	return value;
}

// Hono middleware: extracts session from cookie, sets c.get("session")
export function sessionMiddleware(secret: string) {
	return createMiddleware<AppEnv>(async (c, next) => {
		const cookie = getCookie(c, COOKIE_NAME);
		if (cookie) {
			const session = await getSession(secret, cookie);
			if (session) {
				c.set("session", session);
			}
		}
		await next();
	});
}

export function setSessionCookie(c: Context, signedId: string): void {
	setCookie(c, COOKIE_NAME, signedId, {
		path: "/",
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		maxAge: SESSION_TTL_MS / 1000,
	});
}

export async function clearSessionCookie(c: Context, secret: string): Promise<void> {
	const cookie = getCookie(c, COOKIE_NAME);
	if (cookie) await destroySession(secret, cookie);
	deleteCookie(c, COOKIE_NAME, { path: "/" });
}

/** Sweep expired session rows. The lazy-on-access path in `getSession`
 *  only touches sessions whose owner returns; dormant users never trigger
 *  it, so without this sweep the table grows monotonically. Returns the
 *  number of rows deleted (for logging). */
export async function cleanupExpiredSessions(): Promise<number> {
	const result = await db().deleteFrom("sessions").where("expires_at", "<", new Date()).executeTakeFirst();
	return Number(result.numDeletedRows ?? 0);
}
