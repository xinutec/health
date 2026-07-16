import { describe, expect, it } from "vitest";
import { RailRouteFillQueue, unsnappedTrainRoutes } from "../src/geo/rail-route-fill.js";

const pt = (ts: number) => ({ ts, lat: 51.5 + ts / 1e6, lon: -0.1 });
const points = Array.from({ length: 20 }, (_, i) => pt(100 + i * 10));

function seg(mode: string, startTs: number, endTs: number, wayName?: string, snapped = false) {
	return {
		mode,
		startTs,
		endTs,
		wayName,
		snappedPath: snapped ? [{ lat: 0, lon: 0, ts: startTs }] : undefined,
	};
}

describe("unsnappedTrainRoutes", () => {
	it("picks train legs with a label and no snapped path, with their own fixes", () => {
		const segs = [
			seg("walking", 0, 100),
			seg("train", 100, 200, "A → B · X Line"),
			seg("train", 200, 290, "C → D", true), // already snapped
			seg("train", 290, 300), // no label — nothing to key a route on
		];
		const out = unsnappedTrainRoutes(segs, points);
		expect(out.map((c) => c.key)).toEqual(["A → B · X Line"]);
		expect(out[0].fixes.length).toBeGreaterThan(0);
		expect(out[0].fixes.every((f) => f.lat >= 51.5)).toBe(true);
	});

	it("pools fixes when the same route key appears on two legs", () => {
		const segs = [seg("train", 100, 150, "A → B"), seg("train", 200, 290, "A → B")];
		const out = unsnappedTrainRoutes(segs, points);
		expect(out).toHaveLength(1);
		const single = unsnappedTrainRoutes([seg("train", 100, 150, "A → B")], points);
		expect(out[0].fixes.length).toBeGreaterThan(single[0].fixes.length);
	});

	it("honours refinedMode over mode", () => {
		const segs = [{ ...seg("driving", 100, 200, "A → B"), refinedMode: "train" }];
		expect(unsnappedTrainRoutes(segs, points)).toHaveLength(1);
	});
});

/** Deterministic fake clock + call-recording deps for the queue. */
function harness(
	opts: { exists?: boolean; geometry?: Array<{ lat: number; lon: number }> | null; fail?: boolean } = {},
) {
	const calls = { exists: [] as string[], compute: [] as string[], store: [] as string[] };
	let nowMs = 0;
	const q = new RailRouteFillQueue({
		exists: async (key) => {
			calls.exists.push(key);
			return opts.exists ?? false;
		},
		compute: async (cand) => {
			calls.compute.push(cand.key);
			if (opts.fail) throw new Error("corridor query failed");
			return opts.geometry === undefined
				? [
						{ lat: 1, lon: 2 },
						{ lat: 3, lon: 4 },
					]
				: opts.geometry;
		},
		store: async (key) => {
			calls.store.push(key);
		},
		now: () => nowMs,
		cooldownMs: 1000,
	});
	return { q, calls, advance: (ms: number) => (nowMs += ms) };
}

const cand = (key: string) => ({
	key,
	seg: { startTs: 0, endTs: 60, wayName: key },
	fixes: [{ lat: 51.5, lon: -0.1 }],
});

describe("RailRouteFillQueue", () => {
	it("computes and stores a missing route once", async () => {
		const { q, calls } = harness();
		q.schedule([cand("A → B")]);
		q.schedule([cand("A → B")]); // double-schedule while queued/in-flight
		await q.idle();
		expect(calls.compute).toEqual(["A → B"]);
		expect(calls.store).toEqual(["A → B"]);
	});

	it("does nothing when the route is already cached", async () => {
		const { q, calls } = harness({ exists: true });
		q.schedule([cand("A → B")]);
		await q.idle();
		expect(calls.compute).toEqual([]);
		expect(calls.store).toEqual([]);
	});

	it("cools down an unroutable key instead of recomputing on every view", async () => {
		const { q, calls, advance } = harness({ geometry: null });
		q.schedule([cand("A → B")]);
		await q.idle();
		q.schedule([cand("A → B")]); // still cooling down
		await q.idle();
		expect(calls.compute).toEqual(["A → B"]);
		advance(1001);
		q.schedule([cand("A → B")]);
		await q.idle();
		expect(calls.compute).toEqual(["A → B", "A → B"]);
		expect(calls.store).toEqual([]);
	});

	it("a failed compute cools down too and never throws out of the queue", async () => {
		const { q, calls } = harness({ fail: true });
		q.schedule([cand("A → B")]);
		await q.idle();
		q.schedule([cand("A → B")]);
		await q.idle();
		expect(calls.compute).toEqual(["A → B"]);
		expect(calls.store).toEqual([]);
	});

	it("runs keys serially, not concurrently", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const q = new RailRouteFillQueue({
			exists: async () => false,
			compute: async () => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 5));
				inFlight--;
				return [
					{ lat: 1, lon: 2 },
					{ lat: 3, lon: 4 },
				];
			},
			store: async () => {},
		});
		q.schedule([cand("A → B"), cand("C → D"), cand("E → F")]);
		await q.idle();
		expect(maxInFlight).toBe(1);
	});
});
