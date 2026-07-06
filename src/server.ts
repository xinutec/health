// Side-effect import: makes BigInt JSON-serialisable. DB columns
// like sleep.log_id come back as native bigint, which c.json would
// otherwise crash on. Must be imported before anything that emits
// JSON.
import "./bigint-json.js";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { initPool, withConnection } from "./db/pool.js";
import { migrate } from "./db/schema.js";
import type { AppEnv } from "./env.js";
import { cleanupExpiredSessions, sessionMiddleware } from "./middleware/session.js";
import { shareAuthMiddleware } from "./middleware/share-auth.js";
import { apiRoutes } from "./routes/api.js";
import { fitbitOAuthRoutes } from "./routes/fitbit-oauth.js";
import { internalRoutes } from "./routes/internal.js";
import { nextcloudOAuthRoutes } from "./routes/nextcloud-oauth.js";
import { owntracksRoutes } from "./routes/owntracks.js";
import { escapeHtml } from "./server-html.js";

const config = loadConfig();
initPool(config.db);

// Run migrations on startup
await withConnection(migrate);

// Sweep expired sessions at startup, then once every 6 hours. The lazy
// per-request path in `getSession` only deletes a session when its owner
// returns with the cookie, so dormant accounts would otherwise accumulate.
const sweepSessions = async () => {
	try {
		const n = await cleanupExpiredSessions();
		if (n > 0) console.log(`Swept ${n} expired session(s)`);
	} catch (e) {
		console.error("Session sweep failed:", e);
	}
};
await sweepSessions();
setInterval(sweepSessions, 6 * 60 * 60 * 1000).unref();

const app = new Hono<AppEnv>();

// Global error handler — never leak stack traces
app.onError((err, c) => {
	console.error("Unhandled error:", err);
	return c.json({ error: "internal server error" }, 500);
});

// Request timing — log method, path, status, duration for any request that
// took ≥ 100ms. Quieter than logging everything, surfaces real bottlenecks.
app.use("*", async (c, next) => {
	const t0 = Date.now();
	await next();
	const ms = Date.now() - t0;
	if (ms >= 100) {
		console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
	}
});

// Session middleware on all routes
app.use("*", sessionMiddleware(config.sessionSecret));

// Auxiliary share-token auth runs after session: if the request has
// no cookie but carries an X-Share-Token header that maps to a row,
// authenticate as the owner with `shareViewer` set so downstream
// gates can apply read-only + date-window constraints.
app.use("*", shareAuthMiddleware);

// Health check (no auth) — returns JSON with system status when ?detail=1
app.get("/health", async (c) => {
	if (!c.req.query("detail")) return c.text("ok");
	const t0 = Date.now();
	let dbOk = false;
	let dbLatencyMs = -1;
	let focusPlacesCount: number | null = null;
	let osmCacheCount: number | null = null;
	let lastSyncDate: string | null = null;
	try {
		await withConnection(async (conn) => {
			const fp = (await conn.query("SELECT COUNT(*) AS n FROM focus_places")) as Array<{ n: number }>;
			focusPlacesCount = Number(fp[0]?.n ?? 0);
			const oc = (await conn.query("SELECT COUNT(*) AS n FROM osm_cache")) as Array<{ n: number }>;
			osmCacheCount = Number(oc[0]?.n ?? 0);
			const ss = (await conn.query(
				"SELECT value FROM sync_state WHERE key_name = 'last_sync_date' ORDER BY updated_at DESC LIMIT 1",
			)) as Array<{ value: string }>;
			lastSyncDate = ss[0]?.value ?? null;
		});
		dbLatencyMs = Date.now() - t0;
		dbOk = true;
	} catch (e) {
		console.error("/health detail failed:", e);
	}
	return c.json({
		ok: dbOk,
		dbLatencyMs,
		focusPlacesCount,
		osmCacheCount,
		lastSyncDate,
		uptimeSec: Math.round(process.uptime()),
	});
});

// Build version (no auth) — the commit the running image was built from,
// injected as GIT_SHA at docker build. The UI footer shows it so a stale
// client or deploy is visible at a glance. Deliberately OUTSIDE /api: the
// /api group's requireAuth middleware applies to every /api/* path no matter
// where the handler is registered.
app.get("/version", (c) => c.json({ sha: process.env.GIT_SHA ?? "dev" }));

// OAuth routes. Fitbit uses OAuth for both identity + API access.
// Nextcloud uses OAuth for identity-only (just /login + /auth/callback
// → session cookie); the long-lived app password for API access is
// obtained via Login Flow v2 in the /api/nextcloud/connect/* routes.
app.route("/", nextcloudOAuthRoutes(config));
app.route("/", fitbitOAuthRoutes(config));

// API routes (all require auth)
app.route("/api", apiRoutes(config));

// Internal service-to-service routes (the coach app reads the user's places).
// Gated by the X-Service-Token shared secret, not a session cookie.
app.route("/internal", internalRoutes(config));

// Owntracks proxy. Auth is the session token in the URL (same as the
// PhoneTrack endpoint it forwards to). No session cookie required —
// the request comes from an Android phone, not a browser.
app.route("/owntracks", owntracksRoutes(config));

// Static files (Angular SPA)
app.use("/*", serveStatic({ root: "./public" }));

// SPA fallback: paths that aren't a real file in ./public (e.g.
// /settings, /share/:token) should still load the Angular shell so
// the in-app routing can take over. Only matches "extensionless"
// paths so that genuinely missing assets (typo'd .css/.js) still
// 404 rather than silently returning HTML.
app.get("/settings", serveStatic({ path: "./public/index.html" }));
app.get("/settings/*", serveStatic({ path: "./public/index.html" }));
app.get("/share/:token", serveStatic({ path: "./public/index.html" }));

// Fallback: if no Angular build exists, show a simple landing page
app.get("*", (c) => {
	const session = c.get("session");
	if (!session) {
		return c.html('<h1>Health Dashboard</h1><p><a href="/login">Sign in with Nextcloud</a></p>');
	}
	return c.html(`<h1>Health Dashboard</h1>
    <p>Logged in as ${escapeHtml(session.displayName)}</p>
    <p><a href="/fitbit/auth">Link Fitbit account</a></p>
    <p><a href="/api/activity">Activity API</a> · <a href="/api/sleep">Sleep API</a> · <a href="/api/devices">Devices API</a></p>
    <form method="POST" action="/logout"><button>Logout</button></form>`);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
	console.log(`Health server listening on port ${info.port}`);
});
