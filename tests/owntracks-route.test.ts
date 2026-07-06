/**
 * HTTP-route-level tests for the Owntracks proxy.
 *
 * The pure-function tests in `owntracks.test.ts` cover the decision
 * pipeline. This file covers the gates *before* we touch any state or
 * upstream: token allowlist, Authorization presence, body-size limit.
 *
 * fetch() is stubbed so the tests don't make real outbound calls to
 * Nextcloud — only what the proxy decides about each request is
 * inspected here.
 */

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { owntracksRoutes } from "../src/routes/owntracks.js";

// The route reads focus_places to gate the long-stay demote. We don't
// have a real DB in this test, so stub the loader to return no focus
// places — which is the "transient location everywhere" default and
// keeps these tests focused on the auth gate / body limit / state
// persistence concerns that they were originally written for.
vi.mock("../src/routes/owntracks-focus-cache.js", () => ({
	getFocusPlacesForGating: async () => [],
	_resetFocusCache: () => {},
}));

// PhoneTrack seed mock: the route fetches recent fixes from
// PhoneTrack on cold start to populate the decision pipeline's
// history cache. Default to "no points" so existing tests aren't
// disturbed; individual seed tests below override the mock.
interface MockTrackPoint {
	ts: number;
	lat: number;
	lon: number;
	altitude: number | null;
	speed: number | null;
	accuracy: number | null;
	battery: number | null;
}
const fetchTrackPointsMock = vi.fn<(...args: unknown[]) => Promise<MockTrackPoint[]>>();
fetchTrackPointsMock.mockResolvedValue([]);
vi.mock("../src/nextcloud/phonetrack.js", () => ({
	fetchTrackPoints: (...args: unknown[]) => fetchTrackPointsMock(...args),
	NextcloudNotLinkedError: class NextcloudNotLinkedError extends Error {},
	NextcloudReauthRequiredError: class NextcloudReauthRequiredError extends Error {},
}));

const CONFIG: Config = {
	port: 3000,
	db: { host: "x", port: 3306, user: "x", password: "x", database: "x" },
	fitbit: { clientId: "x", clientSecret: "x", redirectUri: "https://example.com/cb" },
	nextcloud: {
		baseUrl: "https://nc.test",
	},
	owntracks: { allowedTokens: ["abc12345token1", "def67890token2"] },
	serviceTokens: [],
	sessionSecret: "x".repeat(32),
	publicBaseUrl: "https://health.test",
};

function buildApp(): Hono {
	const app = new Hono();
	app.route("/owntracks", owntracksRoutes(CONFIG));
	return app;
}

beforeEach(() => {
	// Stub fetch so a successful path doesn't actually call Nextcloud.
	globalThis.fetch = vi.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
	fetchTrackPointsMock.mockReset();
	fetchTrackPointsMock.mockResolvedValue([]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function validBody(): string {
	return JSON.stringify({ _type: "location", lat: 51.5, lon: -0.1, tst: 1_700_000_000 });
}

describe("Owntracks route — auth gate", () => {
	it("rejects requests with no Authorization header (401)", async () => {
		const app = buildApp();
		const res = await app.request("/owntracks/abc12345token1/Pippijn", {
			method: "POST",
			body: validBody(),
		});
		expect(res.status).toBe(401);
	});

	it("rejects requests with a token not in the allowlist (403)", async () => {
		const app = buildApp();
		const res = await app.request("/owntracks/this-token-isnt-allowed/Pippijn", {
			method: "POST",
			headers: { Authorization: "Basic dXNlcjpwYXNz" },
			body: validBody(),
		});
		expect(res.status).toBe(403);
	});

	it("accepts requests with an allowed token + Authorization", async () => {
		const app = buildApp();
		const res = await app.request("/owntracks/abc12345token1/Pippijn", {
			method: "POST",
			headers: { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" },
			body: validBody(),
		});
		// Stubbed upstream returns 200 with []; proxy adds no cmd since
		// the single fix doesn't trigger any profile change. Response is
		// JSON.
		expect(res.status).toBe(200);
	});

	it("does not reach upstream when token is rejected", async () => {
		// If the allowlist check fires correctly, fetch() never gets called.
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const app = buildApp();
		await app.request("/owntracks/wrong-token/Pippijn", {
			method: "POST",
			headers: { Authorization: "Basic dXNlcjpwYXNz" },
			body: validBody(),
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not reach upstream when Authorization is missing", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const app = buildApp();
		await app.request("/owntracks/abc12345token1/Pippijn", {
			method: "POST",
			body: validBody(),
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("Owntracks route — always-push", () => {
	// The proxy attaches a setConfiguration cmd to every fix response.
	// The phone applies it idempotently. There's no anti-flap timer
	// and no "did this change from last time" dedup — bandwidth is
	// negligible, and pushing every time means a transient state loss
	// on either side recovers on the very next fix.

	it("attaches one cmd to every fix in a steady walking sequence", async () => {
		const app = buildApp();
		const device = "alwayspush-walking";
		const url = `/owntracks/abc12345token1/${device}`;
		const headers = { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" };
		const baseTs = 1_700_000_000;

		const pushCounts: number[] = [];
		for (let i = 0; i < 6; i++) {
			const res = await app.request(url, {
				method: "POST",
				headers,
				body: JSON.stringify({
					_type: "location",
					lat: 51.5 + i * 0.0009,
					lon: -0.1,
					tst: baseTs + i * 60,
					vel: 5,
					m: 2,
				}),
			});
			const body = (await res.json()) as Array<{ _type?: string }>;
			pushCounts.push(body.filter((m) => m._type === "cmd").length);
		}

		// Exactly one cmd per fix, no more no less.
		expect(pushCounts).toEqual([1, 1, 1, 1, 1, 1]);
	});

	it("the very first fix already carries a cmd (factory-default stationary)", async () => {
		const app = buildApp();
		const device = "alwayspush-firstfix";
		const res = await app.request(`/owntracks/abc12345token1/${device}`, {
			method: "POST",
			headers: { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" },
			body: JSON.stringify({ _type: "location", lat: 51.5, lon: -0.1, tst: 1_700_000_000 }),
		});
		const body = (await res.json()) as Array<{ _type?: string; configuration?: { monitoring?: number } }>;
		const cmds = body.filter((m) => m._type === "cmd");
		expect(cmds).toHaveLength(1);
		// No history, no lastProfile → resolves to stationary (monitoring=1).
		expect(cmds[0].configuration?.monitoring).toBe(1);
	});
});

describe("Owntracks route — cold-start seed from PhoneTrack", () => {
	// The in-memory history cache is load-bearing: it's the input to
	// every decision the pipeline makes. After a pod restart it would
	// be empty, leading to premature Move-mode escalations on what is
	// actually a stationary device. Seeding from PhoneTrack on the
	// first fix per (token,device) since process start closes the gap.

	it("calls fetchTrackPoints exactly once across many POSTs for the same device", async () => {
		const app = buildApp();
		const device = "seed-once-per-device";
		const headers = { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" };
		for (let i = 0; i < 4; i++) {
			await app.request(`/owntracks/abc12345token1/${device}`, {
				method: "POST",
				headers,
				body: JSON.stringify({ _type: "location", lat: 51.5, lon: -0.1, tst: 1_700_000_000 + i * 60 }),
			});
		}
		// Idempotent: the seed is attempted once per pod lifetime per
		// (token,device), even if it returns no fixes.
		expect(fetchTrackPointsMock).toHaveBeenCalledTimes(1);
	});

	it("populates the decision pipeline with seeded fixes (hist > 1 on first POST)", async () => {
		// Return 5 stationary historical fixes spanning ~10 minutes
		// at a single location. With the seed, the first Owntracks
		// POST sees hist=6 (5 seeded + 1 new) and the cascade can
		// decline to escalate. Without the seed, hist=1 would force
		// the cold-start branch.
		const baseTs = 1_700_000_000;
		fetchTrackPointsMock.mockResolvedValue(
			Array.from({ length: 5 }, (_, i) => ({
				ts: baseTs - (5 - i) * 60,
				lat: 51.5,
				lon: -0.1,
				altitude: null,
				speed: 0,
				accuracy: null,
				battery: null,
			})),
		);
		const app = buildApp();
		const device = "seed-populates";
		// First POST with `t=u` (the trigger that prompted the
		// production hit). Without the seed, the cascade escalates;
		// with it, history shows sustained zero motion and the
		// cascade refrains from escalating.
		const res = await app.request(`/owntracks/abc12345token1/${device}`, {
			method: "POST",
			headers: { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" },
			body: JSON.stringify({ _type: "location", lat: 51.5, lon: -0.1, tst: baseTs, t: "u", m: 1 }),
		});
		expect(fetchTrackPointsMock).toHaveBeenCalledTimes(1);
		expect(res.status).toBe(200);
	});

	it("survives NextcloudNotLinkedError silently — no escalation, no warning thrown", async () => {
		// New user / unlinked NC: the seed throws NotLinkedError. The
		// proxy must keep working with an empty history (the same
		// behaviour as before this change).
		const { NextcloudNotLinkedError } = (await import("../src/nextcloud/phonetrack.js")) as unknown as {
			NextcloudNotLinkedError: new (msg: string) => Error;
		};
		fetchTrackPointsMock.mockRejectedValue(new NextcloudNotLinkedError("not linked"));
		const app = buildApp();
		const res = await app.request("/owntracks/abc12345token1/seed-unlinked-user", {
			method: "POST",
			headers: { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" },
			body: JSON.stringify({ _type: "location", lat: 51.5, lon: -0.1, tst: 1_700_000_000 }),
		});
		expect(res.status).toBe(200);
	});
});

describe("Owntracks route — body size limit", () => {
	it("rejects payloads larger than 32 KB with 413", async () => {
		const app = buildApp();
		// 64 KB string is well over the 32 KB cap.
		const big = JSON.stringify({ pad: "x".repeat(64 * 1024) });
		const res = await app.request("/owntracks/abc12345token1/Pippijn", {
			method: "POST",
			headers: { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" },
			body: big,
		});
		expect(res.status).toBe(413);
	});

	it("accepts payloads under the cap", async () => {
		const app = buildApp();
		const small = JSON.stringify({ _type: "location", lat: 51.5, lon: -0.1, tst: 1_700_000_000 });
		const res = await app.request("/owntracks/abc12345token1/Pippijn", {
			method: "POST",
			headers: { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" },
			body: small,
		});
		expect(res.status).toBe(200);
	});
});
