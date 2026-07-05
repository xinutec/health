import * as crypto from "node:crypto";
import { Hono } from "hono";
import type { Config } from "../config.js";
import { db } from "../db/pool.js";
import type { AppEnv } from "../env.js";
import { invalidateTokenCache } from "../fitbit/token-manager.js";
import { requireAuth } from "../middleware/auth.js";
import { consumeState, createState } from "../middleware/oauth-state.js";
import type { FitbitTokenPair } from "../types.js";

const ALL_SCOPES = [
	"activity",
	"heartrate",
	"sleep",
	"weight",
	"nutrition",
	"profile",
	"oxygen_saturation",
	"respiratory_rate",
	"temperature",
	"cardio_fitness",
	"electrocardiogram",
	"location",
	"settings",
].join(" ");

function codeVerifier(): string {
	return crypto.randomBytes(64).toString("base64url").slice(0, 128);
}

function codeChallenge(verifier: string): string {
	return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function fitbitOAuthRoutes(config: Config): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const fb = config.fitbit;

	// Initiate Fitbit OAuth (requires Nextcloud session)
	app.get("/fitbit/auth", requireAuth, (c) => {
		const session = c.get("session");
		const verifier = codeVerifier();
		const challenge = codeChallenge(verifier);
		const state = createState({ userId: session.userId, codeVerifier: verifier });

		const url = new URL("https://www.fitbit.com/oauth2/authorize");
		url.searchParams.set("client_id", fb.clientId);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("scope", ALL_SCOPES);
		url.searchParams.set("code_challenge", challenge);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("redirect_uri", fb.redirectUri);
		url.searchParams.set("state", state);
		return c.redirect(url.toString());
	});

	// Fitbit OAuth callback — requires active session matching the state's userId
	app.get("/fitbit/callback", requireAuth, async (c) => {
		const session = c.get("session");
		const state = c.req.query("state") ?? "";
		const pending = consumeState(state);
		if (!pending?.userId || !pending?.codeVerifier) {
			return c.text("Invalid or expired OAuth state. Please try again from /fitbit/auth.", 403);
		}

		if (pending.userId !== session.userId) {
			return c.text("Session user does not match OAuth state. Please try again.", 403);
		}

		const code = c.req.query("code");
		if (!code) {
			return c.text("Missing authorization code.", 400);
		}

		const basicAuth = Buffer.from(`${fb.clientId}:${fb.clientSecret}`).toString("base64");

		const tokenRes = await fetch("https://api.fitbit.com/oauth2/token", {
			method: "POST",
			headers: {
				Authorization: `Basic ${basicAuth}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				client_id: fb.clientId,
				code_verifier: pending.codeVerifier,
				redirect_uri: fb.redirectUri,
			}),
		});

		if (!tokenRes.ok) {
			console.error(`Fitbit token exchange failed: ${tokenRes.status}`, await tokenRes.text());
			return c.text("Fitbit authorization failed. Please try again.", 500);
		}

		const tokens = (await tokenRes.json()) as FitbitTokenPair;

		const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);
		await db()
			.insertInto("tokens")
			.values({
				user_id: pending.userId,
				access_token: tokens.access_token,
				refresh_token: tokens.refresh_token,
				expires_at: newExpiresAt,
				scopes: tokens.scope,
				status: "active",
			})
			.onDuplicateKeyUpdate({
				access_token: tokens.access_token,
				refresh_token: tokens.refresh_token,
				expires_at: newExpiresAt,
				scopes: tokens.scope,
				status: "active",
			})
			.execute();

		// Drop the in-process cache so the next sync run reads the
		// freshly stored tokens instead of any stale entry.
		invalidateTokenCache(pending.userId);

		return c.json({
			success: true,
			linkedTo: pending.userId,
			fitbitUserId: tokens.user_id,
			scopes: tokens.scope,
			message: "Fitbit authorization successful. You can close this page.",
		});
	});

	return app;
}
