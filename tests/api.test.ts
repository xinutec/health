import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env.js";
import { type ApiRoutesConfig, apiRoutes } from "../src/routes/api.js";
import type { UserSession } from "../src/types.js";

const TEST_CONFIG: ApiRoutesConfig = {
	nextcloud: {
		baseUrl: "https://nextcloud.test",
	},
	publicBaseUrl: "https://health.test",
};

// Mock the DB pool module — intercept all Kysely queries
vi.mock("../src/db/pool.js", () => {
	const mockResults: Record<string, unknown[]> = {};

	function setMockResult(table: string, rows: unknown[]) {
		mockResults[table] = rows;
	}

	// Build a chainable mock that captures the query shape
	function createQueryBuilder(table: string) {
		let capturedUserId: string | null = null;

		const builder: Record<string, unknown> = {};
		const chain = (..._args: unknown[]) => builder;

		builder.selectAll = chain;
		builder.select = chain;
		builder.where = (col: string, _op: string, val: unknown) => {
			if (col === "user_id") capturedUserId = val as string;
			return builder;
		};
		builder.orderBy = chain;
		const filterByUser = (rows: unknown[]): unknown[] =>
			rows.filter((r) => (r as { user_id?: string }).user_id === capturedUserId);
		builder.executeTakeFirst = async () => {
			const rows = mockResults[table] ?? [];
			if (capturedUserId) return filterByUser(rows)[0] ?? null;
			return rows[0] ?? null;
		};
		builder.execute = async () => {
			const rows = mockResults[table] ?? [];
			if (capturedUserId) return filterByUser(rows);
			return rows;
		};

		return builder;
	}

	const mockDb = {
		selectFrom: (table: string) => createQueryBuilder(table),
	};

	return {
		db: () => mockDb,
		initPool: vi.fn(),
		getPool: vi.fn(),
		withConnection: vi.fn(),
		destroyPool: vi.fn(),
		__setMockResult: setMockResult,
	};
});

// Import mock setter — the mock factory above adds __setMockResult onto the
// module's exports; the real module shape doesn't have it, so we cast through
// the known mock shape.
const { __setMockResult: setMockResult } = (await import("../src/db/pool.js")) as unknown as {
	__setMockResult: (table: string, rows: unknown[]) => void;
};

// Helper: create a Hono app with API routes and optional session
function createApp(session?: UserSession) {
	const app = new Hono<AppEnv>();

	// Inject session middleware
	if (session) {
		app.use("*", async (c, next) => {
			c.set("session", session);
			await next();
		});
	}

	app.route("/api", apiRoutes(TEST_CONFIG));
	return app;
}

const ALICE: UserSession = { userId: "alice", displayName: "Alice" };
const BOB: UserSession = { userId: "bob", displayName: "Bob" };

describe("API: authentication", () => {
	it("returns 401 for all endpoints without session", async () => {
		const app = createApp(); // no session

		const endpoints = [
			"/api/me",
			"/api/activity",
			"/api/sleep",
			"/api/heartrate/zones",
			"/api/heartrate/intraday",
			"/api/body",
			"/api/spo2",
			"/api/hrv",
			"/api/breathing",
			"/api/temperature",
			"/api/devices",
			"/api/sync-state",
		];

		for (const path of endpoints) {
			const res = await app.request(path);
			expect(res.status, `${path} should return 401`).toBe(401);
			const body = await res.json();
			expect(body.error).toBe("not authenticated");
		}
	});

	it("returns 200 for /api/me with valid session", async () => {
		setMockResult("tokens", []);
		const app = createApp(ALICE);
		const res = await app.request("/api/me");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.userId).toBe("alice");
		expect(body.displayName).toBe("Alice");
		expect(body.fitbitLinked).toBe(false);
	});

	it("shows fitbitLinked=true when tokens exist", async () => {
		setMockResult("tokens", [{ user_id: "alice" }]);
		const app = createApp(ALICE);
		const res = await app.request("/api/me");
		const body = await res.json();
		expect(body.fitbitLinked).toBe(true);
	});
});

describe("API: user isolation", () => {
	it("activity: alice sees only her data", async () => {
		setMockResult("daily_activity", [
			{ user_id: "alice", date: "2026-05-01", steps: 5000 },
			{ user_id: "bob", date: "2026-05-01", steps: 8000 },
		]);

		const app = createApp(ALICE);
		const res = await app.request("/api/activity?days=30");
		expect(res.status).toBe(200);
		const rows = await res.json();
		expect(rows).toHaveLength(1);
		expect(rows[0].user_id).toBe("alice");
		expect(rows[0].steps).toBe(5000);
	});

	it("sleep: bob sees only his data", async () => {
		// log_id is FitbitSleepLogId at the type level, but the mock
		// returns whatever shape the test gives. The DB layer is
		// bypassed by setMockResult so we don't need the brand here —
		// the API endpoint just JSON-serialises whatever it gets.
		setMockResult("sleep", [
			{ user_id: "alice", log_id: 1n, date: "2026-05-01" },
			{ user_id: "bob", log_id: 2n, date: "2026-05-01" },
		]);

		const app = createApp(BOB);
		const res = await app.request("/api/sleep?days=30");
		const rows = await res.json();
		expect(rows).toHaveLength(1);
		expect(rows[0].user_id).toBe("bob");
	});

	it("devices: alice cannot see bob's devices", async () => {
		setMockResult("devices", [
			{ user_id: "alice", device_id: "dev-a" },
			{ user_id: "bob", device_id: "dev-b" },
		]);

		const app = createApp(ALICE);
		const res = await app.request("/api/devices");
		const rows = await res.json();
		expect(rows).toHaveLength(1);
		expect(rows[0].device_id).toBe("dev-a");
	});
});

describe("API: input validation", () => {
	it("rejects days > 365", async () => {
		setMockResult("daily_activity", []);
		const app = createApp(ALICE);
		const res = await app.request("/api/activity?days=999");
		expect(res.status).toBe(500); // zod throws, caught by error handler
	});

	it("rejects negative days", async () => {
		setMockResult("daily_activity", []);
		const app = createApp(ALICE);
		const res = await app.request("/api/activity?days=-1");
		expect(res.status).toBe(500);
	});

	it("defaults to 30 days when not specified", async () => {
		setMockResult("daily_activity", []);
		const app = createApp(ALICE);
		const res = await app.request("/api/activity");
		expect(res.status).toBe(200);
	});

	it("returns 404 for unknown API endpoint", async () => {
		const app = createApp(ALICE);
		const res = await app.request("/api/nonexistent");
		expect(res.status).toBe(404);
	});
});
