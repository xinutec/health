import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env.js";
import { pickCurrentPlace } from "../src/geo/current-place.js";

// --- pure selector -----------------------------------------------------------

const home = { id: 1, displayName: "Home", amenityLabel: null, centroidLat: 51.5, centroidLon: -0.1 };
const gym = { id: 2, displayName: null, amenityLabel: "PureGym", centroidLat: 51.6, centroidLon: -0.2 };

describe("pickCurrentPlace", () => {
	it("returns the place you're standing in", () => {
		const p = pickCurrentPlace({ lat: 51.5, lon: -0.1 }, [home, gym]);
		expect(p?.id).toBe(1);
		expect(p?.label).toBe("Home");
		expect(p?.distanceM).toBe(0);
	});

	it("absorbs GPS jitter within the presence radius", () => {
		// ~60 m north of Home — inside 100 m.
		const p = pickCurrentPlace({ lat: 51.50054, lon: -0.1 }, [home]);
		expect(p?.id).toBe(1);
	});

	it("returns null when you're not near any place", () => {
		expect(pickCurrentPlace({ lat: 52.0, lon: 0.5 }, [home, gym])).toBeNull();
	});

	it("picks the nearest place and falls back to the amenity label", () => {
		const p = pickCurrentPlace({ lat: 51.6, lon: -0.2 }, [home, gym]);
		expect(p?.id).toBe(2);
		expect(p?.label).toBe("PureGym");
	});

	it("returns null for a user with no places", () => {
		expect(pickCurrentPlace({ lat: 51.5, lon: -0.1 }, [])).toBeNull();
	});
});

// --- routes ------------------------------------------------------------------

vi.mock("../src/db/pool.js", () => {
	const mockResults: Record<string, unknown[]> = {};
	function createQueryBuilder(table: string) {
		let capturedUserId: string | null = null;
		const builder: Record<string, unknown> = {};
		const chain = () => builder;
		builder.select = chain;
		builder.selectAll = chain;
		builder.where = (col: string, _op: string, val: unknown) => {
			if (col === "user_id") capturedUserId = val as string;
			return builder;
		};
		builder.execute = async () => {
			const rows = mockResults[table] ?? [];
			return capturedUserId ? rows.filter((r) => (r as { user_id?: string }).user_id === capturedUserId) : rows;
		};
		return builder;
	}
	return {
		db: () => ({ selectFrom: (table: string) => createQueryBuilder(table) }),
		initPool: vi.fn(),
		getPool: vi.fn(),
		withConnection: vi.fn(),
		destroyPool: vi.fn(),
		__setMockResult: (table: string, rows: unknown[]) => {
			mockResults[table] = rows;
		},
	};
});

vi.mock("../src/nextcloud/phonetrack.js", () => ({
	fetchTrackPoints: vi.fn(),
	NextcloudNotLinkedError: class NextcloudNotLinkedError extends Error {},
	NextcloudReauthRequiredError: class NextcloudReauthRequiredError extends Error {},
}));

const { __setMockResult: setMockResult } = (await import("../src/db/pool.js")) as unknown as {
	__setMockResult: (table: string, rows: unknown[]) => void;
};
const { fetchTrackPoints } = (await import("../src/nextcloud/phonetrack.js")) as unknown as {
	fetchTrackPoints: ReturnType<typeof vi.fn>;
};
const { internalRoutes } = await import("../src/routes/internal.js");

const TOKEN = "service-token-0123456789";
const CONFIG = {
	nextcloud: { baseUrl: "https://nc.test" },
	publicBaseUrl: "https://health.test",
	serviceTokens: [TOKEN],
};

function makeApp() {
	const app = new Hono<AppEnv>();
	app.route("/internal", internalRoutes(CONFIG));
	return app;
}

const HOME_ROW = {
	id: 1,
	user_id: "alice",
	centroid_lat: 51.5,
	centroid_lon: -0.1,
	display_name: "Home",
	amenity_label: null,
	total_dwell_sec: 36000,
	visit_count: 10,
	unique_days: 20,
	last_seen_ts: 1000,
};
const GYM_ROW = {
	id: 2,
	user_id: "alice",
	centroid_lat: 51.6,
	centroid_lon: -0.2,
	display_name: null,
	amenity_label: "PureGym",
	total_dwell_sec: 3600,
	visit_count: 5,
	unique_days: 5,
	last_seen_ts: 2000,
};

describe("/internal auth", () => {
	it("rejects a request with no service token", async () => {
		const res = await makeApp().request("/internal/places?user=alice");
		expect(res.status).toBe(401);
	});

	it("rejects a wrong service token", async () => {
		const res = await makeApp().request("/internal/places?user=alice", {
			headers: { "X-Service-Token": "nope" },
		});
		expect(res.status).toBe(401);
	});
});

describe("GET /internal/places", () => {
	it("returns the user's places, labelled, isolated per user", async () => {
		setMockResult("focus_places", [HOME_ROW, GYM_ROW]);
		const res = await makeApp().request("/internal/places?user=alice", {
			headers: { "X-Service-Token": TOKEN },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: number; label: string }[];
		expect(body.map((p) => p.id)).toEqual([1, 2]);
		expect(body.find((p) => p.id === 2)?.label).toBe("PureGym");

		const bob = await makeApp().request("/internal/places?user=bob", {
			headers: { "X-Service-Token": TOKEN },
		});
		expect(await bob.json()).toEqual([]);
	});

	it("400s without a user param", async () => {
		const res = await makeApp().request("/internal/places", {
			headers: { "X-Service-Token": TOKEN },
		});
		expect(res.status).toBe(400);
	});
});

describe("GET /internal/place/current", () => {
	it("returns the place the latest fix is inside", async () => {
		setMockResult("focus_places", [HOME_ROW, GYM_ROW]);
		fetchTrackPoints.mockResolvedValueOnce([
			{ ts: 1, lat: 40, lon: 40, accuracy: 5 },
			{ ts: 2, lat: 51.5, lon: -0.1, accuracy: 5 }, // freshest, at Home
		]);
		const res = await makeApp().request("/internal/place/current?user=alice", {
			headers: { "X-Service-Token": TOKEN },
		});
		expect(res.status).toBe(200);
		expect((await res.json())?.id).toBe(1);
	});

	it("returns null when the latest fix is not near any place", async () => {
		setMockResult("focus_places", [HOME_ROW, GYM_ROW]);
		fetchTrackPoints.mockResolvedValueOnce([{ ts: 2, lat: 48.0, lon: 2.0, accuracy: 5 }]);
		const res = await makeApp().request("/internal/place/current?user=alice", {
			headers: { "X-Service-Token": TOKEN },
		});
		expect(await res.json()).toBeNull();
	});

	it("returns null when there are no fixes", async () => {
		setMockResult("focus_places", [HOME_ROW]);
		fetchTrackPoints.mockResolvedValueOnce([]);
		const res = await makeApp().request("/internal/place/current?user=alice", {
			headers: { "X-Service-Token": TOKEN },
		});
		expect(await res.json()).toBeNull();
	});
});

describe("GET /internal/recovery", () => {
	it("returns latest + baseline per metric, main-sleep only", async () => {
		setMockResult("hrv_daily", [
			{ user_id: "alice", date: "2026-07-01", daily_rmssd: 40 },
			{ user_id: "alice", date: "2026-07-05", daily_rmssd: 55 }, // newest
		]);
		setMockResult("daily_activity", [
			{ user_id: "alice", date: "2026-07-01", resting_heart_rate: 60 },
			{ user_id: "alice", date: "2026-07-05", resting_heart_rate: 58 },
		]);
		setMockResult("sleep", [
			{ user_id: "alice", date: "2026-07-05", minutes_asleep: 450, is_main_sleep: true },
			{ user_id: "alice", date: "2026-07-05", minutes_asleep: 30, is_main_sleep: false }, // nap, ignored
		]);
		const res = await makeApp().request("/internal/recovery?user=alice", {
			headers: { "X-Service-Token": TOKEN },
		});
		expect(res.status).toBe(200);
		const b = (await res.json()) as {
			sleepHours: number;
			hrv: { latest: number; mean: number };
			restingHr: { latest: number };
		};
		expect(b.sleepHours).toBeCloseTo(7.5);
		expect(b.hrv.latest).toBe(55);
		expect(b.hrv.mean).toBe(40);
		expect(b.restingHr.latest).toBe(58);
	});

	it("nulls every field when the user has no biometrics", async () => {
		setMockResult("hrv_daily", []);
		setMockResult("daily_activity", []);
		setMockResult("sleep", []);
		const res = await makeApp().request("/internal/recovery?user=bob", {
			headers: { "X-Service-Token": TOKEN },
		});
		const b = (await res.json()) as Record<string, unknown>;
		expect(b.hrv).toBeNull();
		expect(b.restingHr).toBeNull();
		expect(b.sleepHours).toBeNull();
	});

	it("requires a service token", async () => {
		const res = await makeApp().request("/internal/recovery?user=alice");
		expect(res.status).toBe(401);
	});
});
