import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env.js";

// Rejects requests without a valid session. Must be used after sessionMiddleware.
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
	const session = c.get("session");
	if (!session) {
		return c.json({ error: "not authenticated" }, 401);
	}
	await next();
});
