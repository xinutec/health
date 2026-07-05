/**
 * Tests for the Fitbit token manager. Mirrors the NC token-manager
 * tests because the design is intentionally identical — same
 * concurrent-refresh mutex, same permanent-vs-transient error split,
 * same cache-invalidation semantics. The implementations are kept
 * structurally similar so a bug in one is likely to be visible in the
 * other.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FitbitOAuthConfig } from "../src/fitbit/token-manager.js";

interface TokenRow {
	user_id: string;
	access_token: string;
	refresh_token: string;
	expires_at: Date;
	status: string;
}

const store: { rows: TokenRow[] } = { rows: [] };

vi.mock("../src/db/pool.js", () => {
	function makeSelectChain(table: string) {
		let capturedUserId: string | null = null;
		return {
			select: (_cols: unknown) => ({
				where: (col: string, _op: string, val: unknown) => {
					if (col === "user_id") capturedUserId = val as string;
					return {
						executeTakeFirst: async () => {
							if (table !== "tokens") return null;
							return store.rows.find((r) => r.user_id === capturedUserId) ?? null;
						},
					};
				},
			}),
		};
	}

	function makeUpdateChain(table: string) {
		let pendingSet: Partial<TokenRow> = {};
		let capturedUserId: string | null = null;
		const chain = {
			set: (vals: Partial<TokenRow>) => {
				pendingSet = vals;
				return chain;
			},
			where: (col: string, _op: string, val: unknown) => {
				if (col === "user_id") capturedUserId = val as string;
				return {
					execute: async () => {
						if (table !== "tokens") return;
						const row = store.rows.find((r) => r.user_id === capturedUserId);
						if (row) Object.assign(row, pendingSet);
					},
				};
			},
		};
		return chain;
	}

	const mockDb = {
		selectFrom: (table: string) => makeSelectChain(table),
		updateTable: (table: string) => makeUpdateChain(table),
	};
	return { db: () => mockDb };
});

const CONFIG: FitbitOAuthConfig = { clientId: "client-x", clientSecret: "secret-x" };

let fetchHandler: (url: string, init: RequestInit) => Promise<Response> = async () => {
	throw new Error("fetchHandler not set");
};
const fetchCalls: Array<{ url: string }> = [];

beforeEach(async () => {
	store.rows.length = 0;
	fetchCalls.length = 0;
	fetchHandler = async () => {
		throw new Error("fetchHandler not set");
	};
	globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
		const url = typeof input === "string" ? input : (input as URL).toString();
		fetchCalls.push({ url });
		return fetchHandler(url, (init ?? {}) as RequestInit);
	}) as unknown as typeof fetch;
	vi.resetModules();
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function load() {
	return import("../src/fitbit/token-manager.js");
}

function tokenResponse(access: string, refresh: string, expiresIn = 8 * 3600): Response {
	return new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: expiresIn }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function seedRow(overrides: Partial<TokenRow> = {}): TokenRow {
	const row: TokenRow = {
		user_id: "pippijn",
		access_token: "old-access",
		refresh_token: "old-refresh",
		expires_at: new Date(Date.now() - 1000),
		status: "active",
		...overrides,
	};
	store.rows.push(row);
	return row;
}

describe("Fitbit getValidTokens — basics", () => {
	it("throws FitbitNotLinkedError when no token row exists", async () => {
		const m = await load();
		await expect(m.getValidTokens("pippijn", CONFIG)).rejects.toBeInstanceOf(m.FitbitNotLinkedError);
	});

	it("returns cached tokens without refreshing if not near expiry", async () => {
		const m = await load();
		const future = new Date(Date.now() + 60 * 60 * 1000); // 1h away (> 5min skew)
		seedRow({ expires_at: future, access_token: "fresh-access" });

		const tokens = await m.getValidTokens("pippijn", CONFIG);
		expect(tokens.accessToken).toBe("fresh-access");
		expect(fetchCalls.length).toBe(0);
	});

	it("refreshes when within 5 min of expiry", async () => {
		const m = await load();
		seedRow({ expires_at: new Date(Date.now() + 4 * 60 * 1000) }); // 4min away → refresh
		fetchHandler = async () => tokenResponse("new-access", "new-refresh");

		const tokens = await m.getValidTokens("pippijn", CONFIG);
		expect(tokens.accessToken).toBe("new-access");
		expect(fetchCalls.length).toBe(1);
	});

	it("persists refreshed tokens to DB with status='active'", async () => {
		const m = await load();
		seedRow({ status: "active" });
		fetchHandler = async () => tokenResponse("new-access", "new-refresh");

		await m.getValidTokens("pippijn", CONFIG);
		expect(store.rows[0].access_token).toBe("new-access");
		expect(store.rows[0].refresh_token).toBe("new-refresh");
		expect(store.rows[0].status).toBe("active");
	});
});

describe("Fitbit getValidTokens — concurrent refresh mutex", () => {
	it("10 concurrent callers share exactly one refresh HTTP call", async () => {
		const m = await load();
		seedRow();
		let firstResolve!: (r: Response) => void;
		const firstResponse = new Promise<Response>((res) => {
			firstResolve = res;
		});
		fetchHandler = async () => firstResponse;

		const promises = Array.from({ length: 10 }, () => m.getValidTokens("pippijn", CONFIG));

		await new Promise((r) => setTimeout(r, 0));
		expect(fetchCalls.length).toBe(1);

		firstResolve(tokenResponse("new-access", "new-refresh"));
		const results = await Promise.all(promises);
		expect(results.every((t) => t.accessToken === "new-access")).toBe(true);
		expect(fetchCalls.length).toBe(1);
	});
});

describe("Fitbit getValidTokens — error handling", () => {
	it("4xx response throws FitbitReauthRequiredError", async () => {
		const m = await load();
		seedRow();
		fetchHandler = async () => new Response('{"errors":[{"errorType":"invalid_grant"}]}', { status: 400 });

		await expect(m.getValidTokens("pippijn", CONFIG)).rejects.toBeInstanceOf(m.FitbitReauthRequiredError);
		expect(store.rows[0].status).toBe("needs_reauth");
	});

	it("5xx response throws a generic transient error", async () => {
		const m = await load();
		seedRow();
		fetchHandler = async () => new Response("server boom", { status: 503 });

		await expect(m.getValidTokens("pippijn", CONFIG)).rejects.not.toBeInstanceOf(m.FitbitReauthRequiredError);
		expect(store.rows[0].status).toBe("active"); // unchanged
	});

	it("DB row with status='needs_reauth' short-circuits without hitting Fitbit", async () => {
		const m = await load();
		seedRow({ status: "needs_reauth" });

		await expect(m.getValidTokens("pippijn", CONFIG)).rejects.toBeInstanceOf(m.FitbitReauthRequiredError);
		expect(fetchCalls.length).toBe(0);
	});
});

describe("Fitbit invalidateTokenCache + getConnectionStatus", () => {
	it("invalidate forces re-read from DB", async () => {
		const m = await load();
		seedRow({ expires_at: new Date(Date.now() + 60 * 60 * 1000), access_token: "first" });

		const t1 = await m.getValidTokens("pippijn", CONFIG);
		expect(t1.accessToken).toBe("first");

		store.rows[0].access_token = "second";
		store.rows[0].expires_at = new Date(Date.now() + 2 * 60 * 60 * 1000);

		const cached = await m.getValidTokens("pippijn", CONFIG);
		expect(cached.accessToken).toBe("first");

		m.invalidateTokenCache("pippijn");
		const fresh = await m.getValidTokens("pippijn", CONFIG);
		expect(fresh.accessToken).toBe("second");
	});

	it("getConnectionStatus returns 'not_linked' / 'active' / 'needs_reauth' as expected", async () => {
		const m = await load();
		expect(await m.getConnectionStatus("pippijn")).toBe("not_linked");

		seedRow({ status: "active" });
		expect(await m.getConnectionStatus("pippijn")).toBe("active");

		store.rows[0].status = "needs_reauth";
		expect(await m.getConnectionStatus("pippijn")).toBe("needs_reauth");
	});

	it("getConnectionStatus does not call Fitbit", async () => {
		const m = await load();
		seedRow({ status: "active" });
		await m.getConnectionStatus("pippijn");
		expect(fetchCalls.length).toBe(0);
	});
});
