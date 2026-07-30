/**
 * Auxiliary auth via share token.
 *
 * Runs after `sessionMiddleware` and before `requireAuth`. If the
 * request carries an `X-Share-Token` header that matches a row in
 * `share_tokens`, we set the session as the owner with a
 * `shareViewer` field populated (date window + read-only intent).
 *
 * The same downstream `requireAuth` then sees a populated session
 * and the request flows like any other. Endpoints that mutate state
 * (POST/DELETE/PUT) are blocked by `requireOwnerOnly` to make sure
 * a recipient of a share link can only READ.
 */

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env.js";
import { getShareByToken, touchShareLastAccessed } from "../share/repository.js";
import { shareableDateRange } from "../share/token.js";

const SHARE_HEADER = "X-Share-Token";

export const shareAuthMiddleware = createMiddleware<AppEnv>(async (c, next) => {
	// If a session cookie already authenticated this request, the owner
	// is using their own dashboard — share auth is irrelevant.
	if (c.get("session")) {
		await next();
		return;
	}
	const token = c.req.header(SHARE_HEADER);
	if (!token) {
		await next();
		return;
	}
	const row = await getShareByToken(token);
	if (!row) {
		// Invalid / revoked token. Don't set a session; downstream
		// requireAuth will 401 normally.
		await next();
		return;
	}
	const today = new Date().toISOString().slice(0, 10);
	const range = shareableDateRange(today, row.days_back);
	if (!range) {
		// days_back <= 0 → degenerate; treat as revoked.
		await next();
		return;
	}
	c.set("session", {
		userId: row.user_id,
		// The recipient sees "Shared with you" prefix on the display
		// name in the frontend; backend just returns the owner's name.
		// Could be reset to a generic label if needed later.
		displayName: row.user_id,
		shareViewer: { from: range.from, to: range.to },
	});
	// Fire-and-forget access bump.
	touchShareLastAccessed(token).catch(() => {});
	await next();
});

/** Middleware that rejects mutations from share-viewer sessions.
 *  Mount on the /api group AFTER requireAuth so a missing session
 *  is handled there first. */
/** Paths a share recipient may POST to despite being read-only.
 *
 *  Exactly one, and it is not an exception to the rule so much as outside its
 *  subject: the rule protects the owner's *data*, and telemetry writes to the
 *  log rather than to the database — `POST /api/telemetry` stores nothing.
 *
 *  It is allowed because the alternative is a blind spot exactly where problems
 *  are least visible. A share recipient is the one person who cannot be asked
 *  what they saw, and before this their whole session was invisible.
 *
 *  Safe only because the line names who acted: a share viewer's session carries
 *  the owner's `userId`, so the log says `actor=share` (see `actorOf`). Without
 *  that, opening this path would make the log claim the owner did it.
 *
 *  Named here rather than in the route so the exemption is visible where the
 *  rule is stated, instead of hiding in the one handler it applies to. */
const WRITES_ONLY_TO_THE_LOG = new Set(["/api/telemetry"]);

export const requireOwnerOnly = createMiddleware<AppEnv>(async (c, next) => {
	const session = c.get("session");
	if (session?.shareViewer && c.req.method !== "GET" && !WRITES_ONLY_TO_THE_LOG.has(c.req.path)) {
		return c.json({ error: "read_only_share" }, 403);
	}
	await next();
});
