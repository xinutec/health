import { describe, expect, it } from "vitest";
import type { NearbyStation } from "../src/geo/osm.js";
import {
	TUBE_HOP_BLACKOUT_MIN_KMH,
	TUBE_HOP_BLACKOUT_MIN_SHARE,
	TUBE_HOP_MIN_AVG_KMH,
	TUBE_HOP_SURFACE_MAX_KMH,
	upgradeTubeHops,
} from "../src/geo/passes/tube-hop.js";
import type { TransportMode } from "../src/geo/segments.js";

/**
 * `upgradeTubeHops` rescues a short, clean-GPS Underground hop that slipped
 * past the underground-reconstruction gates (which need ≥180 s and *coarse*
 * cell-tower fixes) and got carved out as a `driving` leg by vehicleSplit —
 * leaving the bus matcher as the only thing that can label it. The real case
 * (2026-06-29): Deepwell → Carfax on the sub-surface line, ~35 km/h,
 * mislabelled "bus 18" because route 18 shares the Marylebone Road corridor.
 *
 * The rule: a *motorised* leg whose board + alight fixes both resolve to
 * stations sharing at least one Underground line, AND whose average speed is
 * above sustained central-London bus pace, is a tube — upgrade it to `train`
 * (which makes it ineligible for the bus passes). Speed is the bus/tube
 * discriminator on a shared corridor; the station-pair is the "it's a rail
 * corridor at all" gate. Synthetic coords, no DB/OSM.
 */

// London-ish: 1° lon ≈ 69_000 m here, so 0.02° ≈ 1380 m between stations.
const LAT = 51.52;
const STATION_A = {
	lat: LAT,
	lon: -0.14,
	name: "Deepwell",
	lines: ["Circle Line", "Hammersmith & City Line", "Metropolitan Line"],
};
const STATION_B = {
	lat: LAT,
	lon: -0.12,
	name: "Carfax",
	lines: ["Circle Line", "Hammersmith & City Line", "Metropolitan Line", "Carfaxloo Line", "Jubilee Line"],
};
const STATION_C = { lat: LAT, lon: -0.1, name: "Liverpool Street", lines: ["Central Line"] };

type Station = { lat: number; lon: number; name: string; lines: string[] };

/** Lookups that resolve a fix to a station / its lines when it's within ~120 m
 *  of one of the given stations, else empty (open road). */
function lookups(stations: Station[]) {
	const near = (lat: number, lon: number): Station | null => {
		for (const s of stations) {
			const dM = Math.hypot((lat - s.lat) * 111_000, (lon - s.lon) * 69_000);
			if (dM <= 120) return s;
		}
		return null;
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

interface Seg {
	startTs: number;
	endTs: number;
	mode: TransportMode;
	refinedMode?: TransportMode;
	refinedReason?: string;
	wayName?: string;
	avgSpeed: number;
}

const T0 = 1_700_000_000;

/** A leg from station `a` to station `b`, `n` fixes, `durationS` long, at the
 *  given reported avgSpeed. Endpoints sit exactly on the stations. */
function leg(
	a: Station,
	b: Station,
	mode: TransportMode,
	avgSpeed: number,
	durationS = 150,
): { seg: Seg; points: Array<{ ts: number; lat: number; lon: number }> } {
	const n = 4;
	const points = Array.from({ length: n }, (_, i) => ({
		ts: T0 + Math.round((i / (n - 1)) * durationS),
		lat: a.lat + ((b.lat - a.lat) * i) / (n - 1),
		lon: a.lon + ((b.lon - a.lon) * i) / (n - 1),
	}));
	return { seg: { startTs: T0, endTs: T0 + durationS, mode, avgSpeed }, points };
}

describe("upgradeTubeHops", () => {
	const lk = lookups([STATION_A, STATION_B, STATION_C]);

	it("upgrades a fast station-to-station driving leg to train (the Deepwell Sq → Carfax case)", async () => {
		const { seg, points } = leg(STATION_A, STATION_B, "driving", 35);
		const [out] = await upgradeTubeHops([seg], points, lk.stationsLookup, lk.linesLookup);
		expect(out.mode).toBe("train");
		expect(out.refinedMode).toBe("train");
		// Multiple shared lines (Circle/H&C/Met) → bare station-pair label, no `· Line`.
		expect(out.wayName).toBe("Deepwell → Carfax");
		expect(out.refinedReason).toMatch(/tube hop/);
	});

	it("names the line when exactly one is shared", async () => {
		// A on Victoria only, B on Victoria only.
		const a = { ...STATION_A, lines: ["Victoria Line"] };
		const b = { ...STATION_B, lines: ["Victoria Line"] };
		const lk2 = lookups([a, b]);
		const { seg, points } = leg(a, b, "driving", 35);
		const [out] = await upgradeTubeHops([seg], points, lk2.stationsLookup, lk2.linesLookup);
		expect(out.mode).toBe("train");
		expect(out.wayName).toBe("Deepwell → Carfax · Victoria Line");
	});

	it("leaves a SLOW station-to-station leg as driving (bus pace — let the bus matcher decide)", async () => {
		const { seg, points } = leg(STATION_A, STATION_B, "driving", 18, 300);
		const [out] = await upgradeTubeHops([seg], points, lk.stationsLookup, lk.linesLookup);
		expect(out.mode).toBe("driving");
		expect(out.wayName).toBeUndefined();
	});

	it("leaves a fast leg whose endpoints share NO line as driving", async () => {
		// A (sub-surface) → C (Central only): no common line.
		const { seg, points } = leg(STATION_A, STATION_C, "driving", 35);
		const [out] = await upgradeTubeHops([seg], points, lk.stationsLookup, lk.linesLookup);
		expect(out.mode).toBe("driving");
	});

	it("leaves a fast leg as driving when only one endpoint is a station (taxi to a station)", async () => {
		const offRoad = { lat: LAT + 0.02, lon: -0.13, name: "nowhere", lines: [] as string[] };
		const { seg, points } = leg(offRoad, STATION_B, "driving", 35);
		const [out] = await upgradeTubeHops([seg], points, lk.stationsLookup, lk.linesLookup);
		expect(out.mode).toBe("driving");
	});

	it("does NOT upgrade a fast driving leg adjacent to a train (a fragment of an existing ride)", async () => {
		// The 2026-06-17 regression: a 2-min sliver off the tail of one continuous
		// Ashvale → Elmford Met ride. Its endpoints happen to anchor to
		// sub-surface stations, but it's part of the ride that just ended, not a
		// separate hop. A real isolated hop is bracketed by walks, never a train.
		const train: Seg = { startTs: T0 - 600, endTs: T0, mode: "train", avgSpeed: 40 };
		const { seg, points } = leg(STATION_A, STATION_B, "driving", 35);
		const [, out] = await upgradeTubeHops([train, seg], points, lk.stationsLookup, lk.linesLookup);
		expect(out.mode).toBe("driving");
		expect(out.wayName).toBeUndefined();
	});

	it("never touches a non-driving leg", async () => {
		const { seg, points } = leg(STATION_A, STATION_B, "walking", 35);
		const [out] = await upgradeTubeHops([seg], points, lk.stationsLookup, lk.linesLookup);
		expect(out.mode).toBe("walking");
		expect(out.wayName).toBeUndefined();
	});

	it("leaves a leg that starts and ends at the same station as driving", async () => {
		const { seg, points } = leg(STATION_A, STATION_A, "driving", 35);
		const [out] = await upgradeTubeHops([seg], points, lk.stationsLookup, lk.linesLookup);
		expect(out.mode).toBe("driving");
	});

	it("exposes the bus-pace threshold as a calibration constant", () => {
		expect(TUBE_HOP_MIN_AVG_KMH).toBeGreaterThan(20);
		expect(TUBE_HOP_MIN_AVG_KMH).toBeLessThan(35);
	});
});

describe("upgradeTubeHops — blackout hop (the one-stop rescue)", () => {
	const lk = lookups([STATION_A, STATION_B, STATION_C]);

	/** The 2026-07-07 shape: a ONE-stop sub-surface hop. The rider walks down
	 *  to the platform (fixes jitter at station A at walking pace), the ride
	 *  itself is a GPS blackout (tunnel), and the phone reacquires at station B
	 *  — so nearly all of the leg's displacement sits in a single inter-fix
	 *  teleport. Dwell drags avgSpeed to ~19 km/h, under the speed gate; the
	 *  bus matcher then claims the leg because the tube runs under the bus
	 *  corridor and the interpolated blackout line passes the bus stops. */
	function blackoutLeg(
		a: Station,
		b: Station,
		avgSpeed = 19,
	): { seg: Seg; points: Array<{ ts: number; lat: number; lon: number }> } {
		const jitter = 0.00013; // ~9 m — platform-access shuffling at walking pace
		const points = [
			{ ts: T0, lat: a.lat, lon: a.lon },
			{ ts: T0 + 20, lat: a.lat + jitter, lon: a.lon },
			{ ts: T0 + 40, lat: a.lat, lon: a.lon + jitter },
			{ ts: T0 + 60, lat: a.lat + jitter, lon: a.lon + jitter },
			{ ts: T0 + 80, lat: a.lat, lon: a.lon },
			// a surviving poor-accuracy fix mid-blackout: still at A, 61 s later
			{ ts: T0 + 141, lat: a.lat + jitter, lon: a.lon },
			// reacquire at B: the whole ride in one 16 s hop
			{ ts: T0 + 157, lat: b.lat, lon: b.lon },
			{ ts: T0 + 171, lat: b.lat + jitter, lon: b.lon },
		];
		return { seg: { startTs: T0, endTs: T0 + 171, mode: "driving", avgSpeed }, points };
	}

	it("upgrades a slow station-to-station leg whose displacement is one blackout teleport", async () => {
		const { seg, points } = blackoutLeg(STATION_A, STATION_B);
		const [out] = await upgradeTubeHops([seg], points, lk.stationsLookup, lk.linesLookup);
		expect(out.mode).toBe("train");
		expect(out.refinedMode).toBe("train");
		expect(out.wayName).toBe("Deepwell → Carfax");
		expect(out.refinedReason).toMatch(/tube hop blackout/);
	});

	it("leaves a bus with a mid-ride GPS hole as driving (observed portions move at bus pace)", async () => {
		// Continuous progress A→B at ~17 km/h with one 90 s hole. The hole's
		// displacement share is under the threshold AND the observed portions
		// move at vehicle pace — both say "surface vehicle, just lost signal".
		const a = STATION_A;
		const b = STATION_B;
		const frac = (f: number) => ({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });
		const points = [
			{ ts: T0, ...frac(0) },
			{ ts: T0 + 30, ...frac(0.11) },
			{ ts: T0 + 60, ...frac(0.22) },
			// 90 s hole while the bus keeps rolling
			{ ts: T0 + 150, ...frac(0.8) },
			{ ts: T0 + 180, ...frac(1) },
		];
		const seg: Seg = { startTs: T0, endTs: T0 + 180, mode: "driving", avgSpeed: 19 };
		const [out] = await upgradeTubeHops([seg], points, lk.stationsLookup, lk.linesLookup);
		expect(out.mode).toBe("driving");
		expect(out.wayName).toBeUndefined();
	});

	it("leaves a blackout leg as driving when the endpoints share no line", async () => {
		const { seg, points } = blackoutLeg(STATION_A, STATION_C);
		const [out] = await upgradeTubeHops([seg], points, lk.stationsLookup, lk.linesLookup);
		expect(out.mode).toBe("driving");
	});

	it("leaves a blackout leg as driving when only one endpoint is a station", async () => {
		const offRoad = { lat: LAT + 0.02, lon: -0.13, name: "nowhere", lines: [] as string[] };
		const { seg, points } = blackoutLeg(offRoad, STATION_B);
		const [out] = await upgradeTubeHops([seg], points, lk.stationsLookup, lk.linesLookup);
		expect(out.mode).toBe("driving");
	});

	it("resolves the board station from the blackout boundary, not the lag-polluted leg start", async () => {
		// The 2026-07-07 second-order bug: the leg's FIRST Kalman fix trails the
		// preceding walk (filter lag) and lands nearer a decoy station; the
		// platform-access cluster — where the observation actually dies — sits at
		// the true board station. Last-seen-before-the-tunnel is the board
		// evidence, first-seen-after is the alight evidence.
		const decoy = { lat: LAT - 0.0015, lon: -0.1415, name: "Decoy Cross", lines: STATION_A.lines };
		const lk2 = lookups([STATION_A, STATION_B, decoy]);
		const jitter = 0.00013;
		const a = STATION_A;
		const b = STATION_B;
		const points = [
			// leg start: walk-lag fix ~130 m west of A, within 120 m of the decoy
			{ ts: T0, lat: decoy.lat + 0.0003, lon: decoy.lon + 0.0003 },
			// platform-access cluster AT station A
			{ ts: T0 + 30, lat: a.lat, lon: a.lon },
			{ ts: T0 + 60, lat: a.lat + jitter, lon: a.lon },
			{ ts: T0 + 141, lat: a.lat, lon: a.lon + jitter },
			// the blackout hop
			{ ts: T0 + 157, lat: b.lat, lon: b.lon },
			{ ts: T0 + 171, lat: b.lat + jitter, lon: b.lon },
		];
		const seg: Seg = { startTs: T0, endTs: T0 + 171, mode: "driving", avgSpeed: 19 };
		const [out] = await upgradeTubeHops([seg], points, lk2.stationsLookup, lk2.linesLookup);
		expect(out.mode).toBe("train");
		expect(out.wayName).toBe("Deepwell → Carfax");
	});

	it("exposes the blackout thresholds as calibration constants", () => {
		expect(TUBE_HOP_BLACKOUT_MIN_SHARE).toBeGreaterThan(0.5);
		expect(TUBE_HOP_BLACKOUT_MIN_KMH).toBeGreaterThan(15);
		expect(TUBE_HOP_SURFACE_MAX_KMH).toBeLessThan(12);
	});
});
