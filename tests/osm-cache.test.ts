/**
 * Cache-correctness tests for `withCache` in src/geo/osm.ts.
 *
 * After the local-mirror switchover, `withCache` is only used by
 * `reverseGeocode` (Nominatim has place-name semantics that aren't
 * a direct match for raw OSM features; the local mirror handles the
 * other four lookups via spatial index). This file therefore drives
 * the cache through `reverseGeocode` and asserts:
 *
 *   - Cache key composition (different zooms → different keys)
 *   - In-flight request dedup (two simultaneous callers share one
 *     fetch)
 *   - Negative caching: 4xx/5xx responses and thrown fetches cache
 *     the failure so a follow-up call doesn't thunder
 *
 * Mocks the DB pool + global.fetch. The Nominatim mirror-fallback
 * tests that used to exist were dropped because Nominatim is a
 * single endpoint — that behaviour lives in `overpassFetch` and is
 * exercised at the integration level by `osm-local.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CacheRow {
	query_type: string;
	lat_rounded: number;
	lon_rounded: number;
	result: string;
}

const cacheStore: CacheRow[] = [];
const cacheSetCalls: Array<{ query_type: string; lat_rounded: number; lon_rounded: number; result: string }> = [];

function findRow(qt: string, lat: number, lon: number): CacheRow | null {
	return cacheStore.find((r) => r.query_type === qt && r.lat_rounded === lat && r.lon_rounded === lon) ?? null;
}

function makeSelectChain() {
	const filters: Record<string, unknown> = {};
	const builder = {
		select: () => builder,
		where(col: string, _op: string, val: unknown) {
			filters[col] = val;
			return builder;
		},
		executeTakeFirst: async () => {
			const row = findRow(filters.query_type as string, filters.lat_rounded as number, filters.lon_rounded as number);
			return row ? { result: row.result } : undefined;
		},
	};
	return builder;
}

function makeInsertChain() {
	let pendingValues: CacheRow | null = null;
	let dupUpdate: { result: string } | null = null;
	const builder = {
		values(v: { query_type: string; lat_rounded: number; lon_rounded: number; result: string }) {
			pendingValues = v as CacheRow;
			return builder;
		},
		onDuplicateKeyUpdate(u: { result: string }) {
			dupUpdate = u;
			return builder;
		},
		execute: async () => {
			if (!pendingValues) return;
			cacheSetCalls.push({ ...pendingValues });
			const existing = findRow(pendingValues.query_type, pendingValues.lat_rounded, pendingValues.lon_rounded);
			if (existing) existing.result = dupUpdate?.result ?? pendingValues.result;
			else cacheStore.push({ ...pendingValues });
		},
	};
	return builder;
}

vi.mock("../src/db/pool.js", () => {
	const mockDb = {
		selectFrom: (_table: string) => makeSelectChain(),
		insertInto: (_table: string) => makeInsertChain(),
	};
	return { db: () => mockDb };
});

// --- fetch mock ---

let fetchHandler: (input: unknown, init?: unknown) => Promise<Response> = async () => {
	throw new Error("fetch handler not set");
};
const fetchCalls: Array<{ url: string; init: unknown }> = [];

beforeEach(() => {
	cacheStore.length = 0;
	cacheSetCalls.length = 0;
	fetchCalls.length = 0;
	fetchHandler = async () => {
		throw new Error("fetch handler not set");
	};
	globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
		const url = typeof input === "string" ? input : (input as URL).toString();
		fetchCalls.push({ url, init });
		return fetchHandler(input, init);
	}) as unknown as typeof fetch;
	vi.resetModules();
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function loadOsm() {
	return await import("../src/geo/osm.js");
}

const nominatimOk = (displayName: string): Response =>
	new Response(JSON.stringify({ display_name: displayName, type: "house", class: "place", address: {} }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

describe("cache key composition", () => {
	it("different zoom values produce different cache keys", async () => {
		const { reverseGeocode } = await loadOsm();
		fetchHandler = async () => nominatimOk("test");

		await reverseGeocode(51.0, 5.0, 16);
		await reverseGeocode(51.0, 5.0, 18);

		// Both should miss cache (different keys) and fetch independently.
		expect(fetchCalls).toHaveLength(2);
		const writeTypes = cacheSetCalls.map((c) => c.query_type);
		expect(new Set(writeTypes).size).toBe(2);
	});
});

describe("in-flight request dedup", () => {
	it("two simultaneous calls for the same key fire fetch only once", async () => {
		const { reverseGeocode } = await loadOsm();
		let resolveFetch: (v: Response) => void = () => {};
		const fetchPromise = new Promise<Response>((r) => {
			resolveFetch = r;
		});
		fetchHandler = () => fetchPromise;

		const p1 = reverseGeocode(51.0, 5.0);
		const p2 = reverseGeocode(51.0, 5.0);

		resolveFetch(nominatimOk("test"));
		await Promise.all([p1, p2]);

		expect(fetchCalls).toHaveLength(1);
	});

	it("simultaneous calls for different keys both fetch", async () => {
		const { reverseGeocode } = await loadOsm();
		fetchHandler = async () => nominatimOk("test");

		await Promise.all([reverseGeocode(51.0, 5.0), reverseGeocode(52.0, 5.0)]);

		expect(fetchCalls).toHaveLength(2);
	});
});

describe("negative caching for transient failures", () => {
	it("caches a 429 response so a follow-up call doesn't re-fetch", async () => {
		const { reverseGeocode } = await loadOsm();
		fetchHandler = async () => new Response("Too Many Requests", { status: 429 });

		const r1 = await reverseGeocode(51.0, 5.0);
		expect(r1).toBeNull();
		const r2 = await reverseGeocode(51.0, 5.0);
		expect(r2).toBeNull();

		// Second call hits negative cache, no extra fetch.
		expect(fetchCalls).toHaveLength(1);
	});

	it("caches a 5xx response (transient server error)", async () => {
		const { reverseGeocode } = await loadOsm();
		fetchHandler = async () => new Response("Bad Gateway", { status: 502 });

		await reverseGeocode(51.0, 5.0);
		await reverseGeocode(51.0, 5.0);

		expect(fetchCalls).toHaveLength(1);
	});

	it("caches a thrown fetch (network/TLS/refused connection)", async () => {
		const { reverseGeocode } = await loadOsm();
		fetchHandler = async () => {
			throw new Error("network down");
		};

		const r1 = await reverseGeocode(51.0, 5.0);
		const r2 = await reverseGeocode(51.0, 5.0);
		expect(r1).toBeNull();
		expect(r2).toBeNull();
		expect(fetchCalls).toHaveLength(1);
	});
});

describe("positive caching", () => {
	it("a successful response is cached and reused on follow-up calls", async () => {
		const { reverseGeocode } = await loadOsm();
		fetchHandler = async () => nominatimOk("Station K");

		const r1 = await reverseGeocode(51.0, 5.0);
		const r2 = await reverseGeocode(51.0, 5.0);
		expect(r1?.displayName).toBe("Station K");
		expect(r2?.displayName).toBe("Station K");
		expect(fetchCalls).toHaveLength(1);
	});
});
