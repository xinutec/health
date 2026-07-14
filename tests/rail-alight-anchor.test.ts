import { describe, expect, it } from "vitest";
import type { EnrichedSegment } from "../src/geo/enriched-segment.js";
import type { FilteredPoint } from "../src/geo/kalman.js";
import type { NearbyStation } from "../src/geo/osm.js";
import { anchorTrainAlightToWalkedStation } from "../src/geo/passes/rail-absorbers.js";

/**
 * `anchorTrainAlightToWalkedStation` — the alight-side mirror of
 * `anchorTrainBoardingToWalkedStation`. When GPS goes dark in a tunnel, the
 * train segment closes where the last clean fix was (the surfaced station),
 * and the rider's continued ride to the true disembark — two stops further on
 * the same line — gets stranded as the FAST leading fixes of the following
 * "walk". The 2026-06-29 outbound: Ashvale → Carfax (alight pinned
 * where GPS surfaced) then a "15-min walk" whose first hop is the Met still
 * doing ~50 km/h on to Deepwell. The fix: extend the train forward to the
 * station the walk's leading hop reaches, re-anchor the alight, trim the walk.
 *
 * Synthetic London-ish coords; all OSM access via injected lookups, no DB.
 */

// Stations (~real positions). Carfax → Deepwell Sq is ~1.5 km east on the
// shared sub-surface corridor (Circle/H&C/Metropolitan).
const ASHVALE = { lat: 51.5635, lon: -0.2795, name: "Ashvale", lines: ["Metropolitan Line", "Jubilee Line"] };
const CARFAX = {
	lat: 51.5226,
	lon: -0.1571,
	name: "Carfax",
	lines: ["Circle Line", "Hammersmith & City Line", "Metropolitan Line"],
};
const DEEPWELL = {
	lat: 51.5258,
	lon: -0.1359,
	name: "Deepwell",
	lines: ["Circle Line", "Hammersmith & City Line", "Metropolitan Line"],
};
const OFFLINE = { lat: 51.5074, lon: -0.1278, name: "Charing Cross", lines: ["Carfaxloo Line", "Northern Line"] };

type Station = { lat: number; lon: number; name: string; lines: string[] };

function lookups(stations: Station[]) {
	const near = (lat: number, lon: number): Station | null => {
		let best: Station | null = null;
		let bestD = Infinity;
		for (const s of stations) {
			const dM = Math.hypot((lat - s.lat) * 111_000, (lon - s.lon) * 69_000);
			if (dM <= 400 && dM < bestD) {
				best = s;
				bestD = dM;
			}
		}
		return best;
	};
	const stationsLookup = async (lat: number, lon: number): Promise<NearbyStation[]> => {
		const s = near(lat, lon);
		return s ? [{ name: s.name, subtype: "subway", distanceM: 10 }] : [];
	};
	const linesLookup = async (lat: number, lon: number): Promise<Set<string>> => {
		const s = near(lat, lon);
		return new Set(s ? s.lines : []);
	};
	return { stationsLookup, linesLookup };
}

const T0 = 1_700_000_000;

function fix(ts: number, lat: number, lon: number): FilteredPoint {
	return { ts, lat, lon, speed_kmh: 0, accuracy: 20, bearing: 0 } as FilteredPoint;
}

function seg(startTs: number, endTs: number, mode: EnrichedSegment["mode"], wayName?: string): EnrichedSegment {
	return { startTs, endTs, mode, avgSpeed: 0, maxSpeed: 0, linearity: 0, pointCount: 4, wayName } as EnrichedSegment;
}

/** A train (board→surfacedAlight) then a walk whose leading hop rides on to
 *  the true alight before settling toward a destination. */
function trainThenWalk(opts?: { wayName?: string; interchangeTail?: boolean; offlineHop?: boolean }) {
	const wayName = opts?.wayName ?? "Ashvale → Carfax";
	const trainEnd = T0;
	const hopTarget = opts?.offlineHop ? OFFLINE : DEEPWELL;
	// walk fixes: Carfax (surfaced) → fast hop → settle near target → walk to dest
	const w0 = fix(T0, CARFAX.lat, CARFAX.lon); // surfaced alight
	const w1 = fix(T0 + 120, hopTarget.lat, hopTarget.lon); // 1.5 km in 2 min = fast hop
	const w2 = fix(T0 + 180, hopTarget.lat - 0.0015, hopTarget.lon - 0.0008); // slow drift
	const w3 = fix(T0 + 300, hopTarget.lat - 0.003, hopTarget.lon - 0.0015); // dest, slow
	const points = [fix(trainEnd - 300, ASHVALE.lat, ASHVALE.lon), fix(trainEnd - 100, 51.55, -0.25), w0, w1, w2, w3];
	const segs: EnrichedSegment[] = [seg(trainEnd - 300, trainEnd, "train", wayName), seg(T0, T0 + 300, "walking")];
	if (opts?.interchangeTail) segs.push(seg(T0 + 300, T0 + 600, "train", "Deepwell → Elmford"));
	return { segs, points };
}

describe("anchorTrainAlightToWalkedStation", () => {
	const lk = lookups([ASHVALE, CARFAX, DEEPWELL, OFFLINE]);

	it("extends the train to the downline station the walk's leading hop reached (the 06-29 case)", async () => {
		const { segs, points } = trainThenWalk();
		const out = await anchorTrainAlightToWalkedStation(segs, points, lk.stationsLookup, lk.linesLookup);
		expect(out[0].mode).toBe("train");
		expect(out[0].wayName).toBe("Ashvale → Deepwell");
		// the train now ends where it settled (the hop's end), and the walk starts there
		expect(out[0].endTs).toBe(T0 + 120);
		expect(out[1].startTs).toBe(T0 + 120);
		expect(out[0].refinedReason).toMatch(/alight re-anchored/i);
	});

	it("preserves the line suffix when the run had one", async () => {
		const { segs, points } = trainThenWalk({ wayName: "Ashvale → Carfax · Metropolitan Line" });
		const out = await anchorTrainAlightToWalkedStation(segs, points, lk.stationsLookup, lk.linesLookup);
		expect(out[0].wayName).toBe("Ashvale → Deepwell · Metropolitan Line");
	});

	it("does NOT fire on a train→walk→train interchange (owned by the journey passes)", async () => {
		const { segs, points } = trainThenWalk({ interchangeTail: true });
		const out = await anchorTrainAlightToWalkedStation(segs, points, lk.stationsLookup, lk.linesLookup);
		expect(out[0].wayName).toBe("Ashvale → Carfax");
		expect(out[1].startTs).toBe(T0);
	});

	it("does NOT extend to a station off the run's line (line-continuity guard)", async () => {
		const { segs, points } = trainThenWalk({ offlineHop: true });
		const out = await anchorTrainAlightToWalkedStation(segs, points, lk.stationsLookup, lk.linesLookup);
		expect(out[0].wayName).toBe("Ashvale → Carfax");
	});

	it("extends the train when the leading ride is a DENSE fast run (no single step clears the sparse-hop floor)", async () => {
		// Overground alight with continuous GPS: the ride into the true
		// disembark is many short vehicle-paced steps (14 s apart, each
		// ~215 m ≈ 55 km/h — individually UNDER the 250 m sparse-hop floor),
		// not one long blackout jump. The settle must be found on the RUN's
		// net displacement, not on any single step.
		const trainEnd = T0;
		const N = 7;
		const walkFixes: FilteredPoint[] = [];
		for (let i = 0; i <= N; i++) {
			const f = i / N;
			walkFixes.push(
				fix(T0 + i * 14, CARFAX.lat + (DEEPWELL.lat - CARFAX.lat) * f, CARFAX.lon + (DEEPWELL.lon - CARFAX.lon) * f),
			);
		}
		const settleTs = T0 + N * 14;
		// genuine slow walk away from the station afterwards
		walkFixes.push(fix(settleTs + 60, DEEPWELL.lat - 0.0015, DEEPWELL.lon - 0.0008));
		walkFixes.push(fix(settleTs + 180, DEEPWELL.lat - 0.003, DEEPWELL.lon - 0.0015));
		const points = [fix(trainEnd - 300, ASHVALE.lat, ASHVALE.lon), fix(trainEnd - 100, 51.55, -0.25), ...walkFixes];
		const segs: EnrichedSegment[] = [
			seg(trainEnd - 300, trainEnd, "train", "Ashvale → Carfax · Metropolitan Line"),
			seg(T0, settleTs + 180, "walking"),
		];
		const out = await anchorTrainAlightToWalkedStation(segs, points, lk.stationsLookup, lk.linesLookup);
		expect(out[0].wayName).toBe("Ashvale → Deepwell · Metropolitan Line");
		expect(out[0].endTs).toBe(settleTs);
		expect(out[1].startTs).toBe(settleTs);
	});

	it("extends the boundary even when the settled station IS the leg's current alight label", async () => {
		// The rail-run topology often gets the alight NAME right while the
		// boundary TIME lands early (the label is anchored on stations, the
		// cut on windows). The walked-to station equalling the current label
		// must not read as "nothing to do": the ride tail is still stranded
		// in the walk and the leg must extend to the settle fix.
		const trainEnd = T0;
		const N = 7;
		const walkFixes: FilteredPoint[] = [];
		for (let i = 0; i <= N; i++) {
			const f = i / N;
			walkFixes.push(
				fix(T0 + i * 14, CARFAX.lat + (DEEPWELL.lat - CARFAX.lat) * f, CARFAX.lon + (DEEPWELL.lon - CARFAX.lon) * f),
			);
		}
		const settleTs = T0 + N * 14;
		walkFixes.push(fix(settleTs + 60, DEEPWELL.lat - 0.0015, DEEPWELL.lon - 0.0008));
		walkFixes.push(fix(settleTs + 180, DEEPWELL.lat - 0.003, DEEPWELL.lon - 0.0015));
		const points = [fix(trainEnd - 300, ASHVALE.lat, ASHVALE.lon), fix(trainEnd - 100, 51.55, -0.25), ...walkFixes];
		const segs: EnrichedSegment[] = [
			seg(trainEnd - 300, trainEnd, "train", "Ashvale → Deepwell · Metropolitan Line"),
			seg(T0, settleTs + 180, "walking"),
		];
		const out = await anchorTrainAlightToWalkedStation(segs, points, lk.stationsLookup, lk.linesLookup);
		expect(out[0].wayName).toBe("Ashvale → Deepwell · Metropolitan Line"); // label untouched
		expect(out[0].endTs).toBe(settleTs); // boundary moved
		expect(out[1].startTs).toBe(settleTs);
		expect(out[0].refinedReason).toMatch(/reclaimed/i);
	});

	it("does NOT extend on an isolated reacquire teleport landing at the labelled alight (stuck-GPS walk)", async () => {
		// GPS stuck at the previous station while the rider already alighted
		// and walks: the walk's fixes are walking-pace with ISOLATED teleport
		// steps as GPS catches up, the last one landing at the labelled
		// alight. A single fast step is stale-GPS reacquire, not a ride —
		// the confirmed walk's head must not be eaten by the train.
		const trainEnd = T0;
		const w = (i: number, lat: number, lon: number) => fix(T0 + i, lat, lon);
		const points = [
			fix(trainEnd - 300, ASHVALE.lat, ASHVALE.lon),
			fix(trainEnd - 100, 51.55, -0.25),
			// walk fixes: stuck near Carfax, teleport toward Deepwell, walk, teleport to Deepwell, walk on
			w(0, CARFAX.lat, CARFAX.lon),
			w(14, CARFAX.lat - 0.0001, CARFAX.lon + 0.0003), // walking pace
			w(105, CARFAX.lat + 0.001, CARFAX.lon + 0.0135), // 91 s gap, ~930 m — isolated teleport
			w(125, CARFAX.lat + 0.0009, CARFAX.lon + 0.0138), // walking pace
			w(139, CARFAX.lat + 0.0008, CARFAX.lon + 0.014), // walking pace
			w(178, DEEPWELL.lat, DEEPWELL.lon), // 39 s, ~580 m — isolated teleport to the alight
			w(198, DEEPWELL.lat + 0.0001, DEEPWELL.lon - 0.0004), // walking pace
			w(300, DEEPWELL.lat - 0.001, DEEPWELL.lon - 0.002), // walks away
		];
		const segs: EnrichedSegment[] = [
			seg(trainEnd - 300, trainEnd, "train", "Ashvale → Deepwell · Metropolitan Line"),
			seg(T0, T0 + 300, "walking"),
		];
		const out = await anchorTrainAlightToWalkedStation(segs, points, lk.stationsLookup, lk.linesLookup);
		expect(out[0].endTs).toBe(trainEnd); // boundary untouched
		expect(out[1].startTs).toBe(T0);
	});

	it("does NOT fire on dense walking jitter (short fast steps with no accumulated displacement)", async () => {
		// A walk whose GPS jitters fast for single steps but goes nowhere at
		// vehicle pace: isolated ≥15 km/h steps, each immediately followed by
		// slow steps, never accumulating an inter-station net displacement.
		const trainEnd = T0;
		const walkFixes: FilteredPoint[] = [];
		for (let i = 0; i <= 10; i++) {
			// alternate ±40 m around Carfax every 8 s: step speed ~18 km/h, net ~0
			const off = i % 2 === 0 ? 0.0004 : 0;
			walkFixes.push(fix(T0 + i * 8, CARFAX.lat + off, CARFAX.lon));
		}
		const points = [fix(trainEnd - 300, ASHVALE.lat, ASHVALE.lon), fix(trainEnd - 100, 51.55, -0.25), ...walkFixes];
		const segs: EnrichedSegment[] = [
			seg(trainEnd - 300, trainEnd, "train", "Ashvale → Carfax"),
			seg(T0, T0 + 80, "walking"),
		];
		const out = await anchorTrainAlightToWalkedStation(segs, points, lk.stationsLookup, lk.linesLookup);
		expect(out[0].wayName).toBe("Ashvale → Carfax");
		expect(out[1].startTs).toBe(T0);
	});

	it("leaves a plain walk (no fast leading hop) untouched", async () => {
		const { segs, points } = trainThenWalk();
		// rewrite the walk's leading hop to walking pace (small steps)
		points[3] = fix(T0 + 120, CARFAX.lat + 0.0003, CARFAX.lon + 0.0003);
		points[4] = fix(T0 + 240, CARFAX.lat + 0.0006, CARFAX.lon + 0.0006);
		points[5] = fix(T0 + 300, CARFAX.lat + 0.0009, CARFAX.lon + 0.0009);
		const out = await anchorTrainAlightToWalkedStation(segs, points, lk.stationsLookup, lk.linesLookup);
		expect(out[0].wayName).toBe("Ashvale → Carfax");
		expect(out[1].startTs).toBe(T0);
	});
});
