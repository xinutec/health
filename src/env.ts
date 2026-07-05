import type { UserSession } from "./types.js";

// Hono environment type — declares variables available via c.get()/c.set()
export type AppEnv = {
	Variables: {
		session: UserSession;
	};
};
