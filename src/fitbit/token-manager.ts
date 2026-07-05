/**
 * Centralised Fitbit OAuth token manager.
 *
 * Mirrors the Nextcloud equivalent (`src/nextcloud/token-manager.ts`).
 * See that file for the full design rationale. The short version: when
 * we eventually parallelise sync (or any caller fires concurrent
 * Fitbit requests across the expiry boundary), this prevents N
 * simultaneous POSTs to Fitbit's `/oauth2/token` endpoint that would
 * (a) waste round-trips, (b) race on refresh-token rotation, and
 * (c) trip Fitbit's brute-force throttling.
 *
 * Today's `sync.ts` calls per user sequentially, so the bug is latent.
 * Fixed proactively because the architectural shape was flagged in
 * code review and a future parallelisation would re-introduce the
 * same problem we just solved for Nextcloud.
 */

import { db } from "../db/pool.js";

const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh ≥5min before expiry

interface FitbitTokens {
	accessToken: string;
	refreshToken: string;
	expiresAtMs: number;
}

interface CacheEntry {
	tokens: FitbitTokens;
	refreshPromise: Promise<FitbitTokens> | null;
}

const cache = new Map<string, CacheEntry>();
const loadingPromises = new Map<string, Promise<CacheEntry>>();

export interface FitbitOAuthConfig {
	clientId: string;
	clientSecret: string;
}

export class FitbitNotLinkedError extends Error {
	constructor() {
		super("Fitbit not linked");
		this.name = "FitbitNotLinkedError";
	}
}

export class FitbitReauthRequiredError extends Error {
	constructor(
		public readonly upstreamStatus: number,
		public readonly upstreamBody: string,
	) {
		super(`Fitbit refresh rejected (${upstreamStatus}): ${upstreamBody}`);
		this.name = "FitbitReauthRequiredError";
	}
}

async function loadFromDb(userId: string): Promise<{ tokens: FitbitTokens; status: string } | null> {
	const row = await db()
		.selectFrom("tokens")
		.select(["access_token", "refresh_token", "expires_at", "status"])
		.where("user_id", "=", userId)
		.executeTakeFirst();
	if (!row) return null;
	return {
		tokens: {
			accessToken: row.access_token,
			refreshToken: row.refresh_token,
			expiresAtMs: new Date(row.expires_at).getTime(),
		},
		status: row.status,
	};
}

async function persistRefreshedTokens(userId: string, tokens: FitbitTokens): Promise<void> {
	await db()
		.updateTable("tokens")
		.set({
			access_token: tokens.accessToken,
			refresh_token: tokens.refreshToken,
			expires_at: new Date(tokens.expiresAtMs),
			status: "active",
		})
		.where("user_id", "=", userId)
		.execute();
}

async function markReauthRequired(userId: string): Promise<void> {
	await db().updateTable("tokens").set({ status: "needs_reauth" }).where("user_id", "=", userId).execute();
}

async function doRefresh(userId: string, current: FitbitTokens, config: FitbitOAuthConfig): Promise<FitbitTokens> {
	const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
	const res = await fetch("https://api.fitbit.com/oauth2/token", {
		method: "POST",
		headers: {
			Authorization: `Basic ${basicAuth}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: current.refreshToken,
		}),
	});

	const body = await res.text();
	if (!res.ok) {
		// 4xx = refresh token is dead (invalid, expired, revoked, throttled).
		// Permanent — flip DB status so /api/me surfaces "needs_reauth".
		// 5xx / network errors are transient; caller may retry.
		if (res.status >= 400 && res.status < 500) {
			await markReauthRequired(userId);
			throw new FitbitReauthRequiredError(res.status, body);
		}
		throw new Error(`Fitbit token refresh failed: ${res.status} ${body}`);
	}

	const data = JSON.parse(body) as { access_token: string; refresh_token: string; expires_in?: number };
	const expiresIn = data.expires_in ?? 8 * 3600;
	const newTokens: FitbitTokens = {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAtMs: Date.now() + expiresIn * 1000,
	};
	await persistRefreshedTokens(userId, newTokens);
	console.log(`Fitbit token refreshed for user=${userId} (expires in ${expiresIn}s)`);
	return newTokens;
}

async function getOrLoadEntry(userId: string): Promise<CacheEntry> {
	const cached = cache.get(userId);
	if (cached) return cached;

	const inFlight = loadingPromises.get(userId);
	if (inFlight) return inFlight;

	const promise = (async () => {
		const loaded = await loadFromDb(userId);
		if (!loaded) throw new FitbitNotLinkedError();
		if (loaded.status === "needs_reauth") {
			throw new FitbitReauthRequiredError(0, "cached: needs_reauth");
		}
		const entry: CacheEntry = { tokens: loaded.tokens, refreshPromise: null };
		cache.set(userId, entry);
		return entry;
	})().finally(() => {
		loadingPromises.delete(userId);
	});
	loadingPromises.set(userId, promise);
	return promise;
}

export async function getValidTokens(userId: string, config: FitbitOAuthConfig): Promise<FitbitTokens> {
	const entry = await getOrLoadEntry(userId);

	if (Date.now() < entry.tokens.expiresAtMs - REFRESH_SKEW_MS) {
		return entry.tokens;
	}

	if (entry.refreshPromise) {
		return entry.refreshPromise;
	}

	const refreshPromise = doRefresh(userId, entry.tokens, config)
		.then((newTokens) => {
			cache.set(userId, { tokens: newTokens, refreshPromise: null });
			return newTokens;
		})
		.catch((err) => {
			const current = cache.get(userId);
			if (current) cache.set(userId, { ...current, refreshPromise: null });
			throw err;
		});

	entry.refreshPromise = refreshPromise;
	cache.set(userId, entry);
	return refreshPromise;
}

export function invalidateTokenCache(userId: string): void {
	cache.delete(userId);
}

export type FitbitConnectionStatus = "active" | "needs_reauth" | "not_linked";

export async function getConnectionStatus(userId: string): Promise<FitbitConnectionStatus> {
	const row = await db().selectFrom("tokens").select(["status"]).where("user_id", "=", userId).executeTakeFirst();
	if (!row) return "not_linked";
	if (row.status === "needs_reauth") return "needs_reauth";
	return "active";
}

export function _resetCache(): void {
	cache.clear();
	loadingPromises.clear();
}
