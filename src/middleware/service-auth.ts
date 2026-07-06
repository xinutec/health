/**
 * Service-to-service auth for the internal endpoints (`/internal/*`).
 *
 * Unlike the session and share middlewares, this establishes NO session —
 * internal endpoints take the target user as a query param and are called by
 * another trusted fleet service (coach), not by a browser. Auth is a shared
 * secret in the `X-Service-Token` header, matched against the configured
 * tokens (see `config.serviceTokens`, env `SERVICE_TOKEN`). An empty token
 * list (the default) rejects everything, so the internal API is off unless a
 * secret is provisioned.
 *
 * Mirrors the owntracks `allowedTokens` model: presence-of-secret gating, no
 * session, no data leaked to other routes.
 */

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env.js";

const SERVICE_HEADER = "X-Service-Token";

export function serviceAuth(tokens: readonly string[]) {
	return createMiddleware<AppEnv>(async (c, next) => {
		const token = c.req.header(SERVICE_HEADER);
		if (!token || !tokens.includes(token)) {
			return c.json({ error: "unauthorized" }, 401);
		}
		await next();
	});
}
