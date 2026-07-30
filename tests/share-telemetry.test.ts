/**
 * A share recipient's activity must be visible, and must not be attributed to
 * the owner.
 *
 * `shareAuthMiddleware` grants a recipient a session carrying the *owner's*
 * `userId` — that is how they get read access at all. Two consequences, and the
 * second is why this file exists:
 *
 *   - `requireOwnerOnly` rejects their non-GET requests, which silently included
 *     `POST /api/telemetry`, so their whole session was invisible. A share
 *     recipient is the one person who cannot be asked what they saw.
 *   - Opening that path without saying who acted would make every line claim the
 *     owner did it. A gap in a log is visible; a lie in one is not.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requireOwnerOnly } from "../src/middleware/share-auth.js";
import { actorOf } from "../src/routes/api.js";
import type { UserSession } from "../src/types.js";

/** A share-viewer session, as shareAuthMiddleware builds one: the owner's id,
 *  plus the window that marks it as a recipient rather than the owner. */
const viewer: UserSession = {
	userId: "pippijn",
	displayName: "Pippijn",
	shareViewer: { from: "2026-05-08", to: "2026-05-14" },
};
const owner: UserSession = { userId: "pippijn", displayName: "Pippijn" };

describe("actorOf", () => {
	it("calls the owner the owner", () => {
		expect(actorOf(owner)).toBe("owner");
	});

	it("does not let a share recipient be logged as the owner", () => {
		// Both sessions carry userId "pippijn" — that is the whole problem. The
		// only thing separating them in the log is this.
		expect(actorOf(viewer)).toBe("share");
		expect(actorOf(viewer)).not.toBe(actorOf(owner));
	});
});

/** A Hono app with a share-viewer session already set, so the middleware under
 *  test sees exactly what it sees in production. */
function appAsShareViewer() {
	// biome-ignore lint/suspicious/noExplicitAny: a test double for AppEnv's session
	const app = new Hono<any>();
	app.use("/*", async (c, next) => {
		c.set("session", viewer);
		await next();
	});
	app.use("/*", requireOwnerOnly);
	app.all("/*", (c) => c.text("reached"));
	return app;
}

describe("requireOwnerOnly", () => {
	it("still refuses a share recipient every write to the data", async () => {
		const app = appAsShareViewer();
		for (const [method, path] of [
			["POST", "/api/share"],
			["DELETE", "/api/share"],
			["POST", "/api/client-log"],
		] as const) {
			const res = await app.request(path, { method });
			expect(res.status, `${method} ${path}`).toBe(403);
			expect(await res.json()).toEqual({ error: "read_only_share" });
		}
	});

	it("lets a share recipient report what they did", async () => {
		// The gap this closes. Telemetry writes to the log, not to the owner's
		// data, and the line says actor=share — so allowing it neither leaks nor
		// misattributes.
		const res = await appAsShareViewer().request("/api/telemetry", { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("reached");
	});

	it("reads are untouched", async () => {
		const res = await appAsShareViewer().request("/api/velocity");
		expect(res.status).toBe(200);
	});
});
