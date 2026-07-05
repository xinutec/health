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
