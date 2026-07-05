import { describe, expect, it } from "vitest";
import {
	assignDisplayNames,
	type Cluster,
	classifyCluster,
	clusterStays,
	detectFocusPlaces,
	detectStays,
	HOUR_BUCKETS,
	hourProfileForRange,
	hourProfileOf,
	localSolarDayOfWeek,
	localSolarHour,
	parseHourProfile,
	pickWinningAmenity,
	type RawPoint,
	type Stay,
	serializeHourProfile,
	splitCluster,
	uniqueDayCount,
} from "../src/geo/focus-places.js";

// Helpers
function offset(lat: number, lon: number, north: number, east: number): { lat: number; lon: number } {
	const dLat = north / 111320;
	const dLon = east / (111320 * Math.cos((lat * Math.PI) / 180));
	return { lat: lat + dLat, lon: lon + dLon };
}

const HOME_LAT = 51.56997;
const HOME_LON = -0.27896;

function point(ts: number, lat: number, lon: number, accuracy: number | null = 20): RawPoint {
	return { ts, lat, lon, accuracy };
}

// ts builder: days/hours/minutes since 2026-02-09 00:00 UTC
const BASE_TS = Math.floor(Date.UTC(2026, 1, 9) / 1000);
function at(daysFromBase: number, hour = 0, minute = 0): number {
	return BASE_TS + daysFromBase * 86400 + hour * 3600 + minute * 60;
}

// Synthetic stay: emit one fix every `intervalMin` for `durationMin` minutes
// at a tight cluster around (lat, lon).
function stayPoints(startTs: number, durationMin: number, intervalMin: number, lat: number, lon: number): RawPoint[] {
	const out: RawPoint[] = [];
	const intervalSec = intervalMin * 60;
	const endTs = startTs + durationMin * 60;
	for (let t = startTs; t <= endTs; t += intervalSec) {
		// jitter by ~5m
		const j = offset(lat, lon, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
		out.push(point(t, j.lat, j.lon, 15));
	}
	return out;
}

describe("detectStays", () => {
	it("returns nothing for empty input", () => {
		expect(detectStays([])).toEqual([]);
	});

	it("emits one stay for points clustered tightly for ≥ 10 min", () => {
		const pts = stayPoints(at(0, 9), 60, 5, HOME_LAT, HOME_LON);
		const stays = detectStays(pts);
		expect(stays).toHaveLength(1);
		expect(stays[0].pointCount).toBeGreaterThan(2);
		expect(stays[0].durationSec).toBeGreaterThanOrEqual(600);
		// Centroid should be very close to the seed location
		expect(Math.abs(stays[0].centroidLat - HOME_LAT)).toBeLessThan(0.0001);
	});

	it("does NOT emit a stay if the window is shorter than 10 min", () => {
		const pts = stayPoints(at(0, 9), 5, 1, HOME_LAT, HOME_LON);
		expect(detectStays(pts)).toHaveLength(0);
	});

	it("breaks the window when the user moves elsewhere", () => {
		// 30 min at home, then 30 min ~5km away at work
		const home = stayPoints(at(0, 9), 30, 5, HOME_LAT, HOME_LON);
		const work = stayPoints(at(0, 10), 30, 5, HOME_LAT + 0.05, HOME_LON);
		const stays = detectStays([...home, ...work]);
		expect(stays).toHaveLength(2);
		expect(stays[0].centroidLat).toBeCloseTo(HOME_LAT, 3);
		expect(stays[1].centroidLat).toBeCloseTo(HOME_LAT + 0.05, 3);
	});

	it("treats overnight phone-silence as a continuous stay (no max-gap rule)", () => {
		// One fix at 23:00, next at 07:00 next day, both at home
		const last = point(at(0, 23), HOME_LAT, HOME_LON, 20);
		const first = point(at(1, 7), HOME_LAT + 0.00001, HOME_LON + 0.00001, 20);
		const stays = detectStays([last, first]);
		expect(stays).toHaveLength(1);
		expect(stays[0].durationSec).toBe(8 * 3600);
	});
});

describe("clusterStays", () => {
	it("merges two distinct stays at the same place into one cluster", () => {
		// Test clusterStays directly — two synthetic stays at the same coords
		// (detectStays would merge them because of the no-gap rule).
		const stays: Stay[] = [stay(0, 12, HOME_LAT, HOME_LON), stay(7, 12, HOME_LAT, HOME_LON)];
		const clusters = clusterStays(stays);
		expect(clusters).toHaveLength(1);
		expect(clusters[0].stays).toHaveLength(2);
	});

	it("keeps distinct clusters for places > 200m apart", () => {
		// HOME and 500m east
		const home = stayPoints(at(0, 9), 30, 5, HOME_LAT, HOME_LON);
		const far = offset(HOME_LAT, HOME_LON, 0, 500);
		const elsewhere = stayPoints(at(1, 9), 30, 5, far.lat, far.lon);
		const stays = detectStays([...home, ...elsewhere]);
		const clusters = clusterStays(stays);
		expect(clusters.length).toBeGreaterThanOrEqual(2);
	});

	it("post-merge pass combines clusters that drifted within radius", () => {
		// First three stays are slightly offset from each other so greedy
		// clustering creates one cluster whose centroid moves between them.
		// A fourth stay then ties two of those drifted-apart clusters together.
		// Set up: three stays at lat 0, 0+25m, 0+50m, 0+75m east.
		const off60 = offset(HOME_LAT, HOME_LON, 0, 60);
		const off120 = offset(HOME_LAT, HOME_LON, 0, 120);
		const off80 = offset(HOME_LAT, HOME_LON, 0, 80);
		const stays: Stay[] = [
			stay(0, 9, HOME_LAT, HOME_LON),
			stay(1, 9, off60.lat, off60.lon),
			stay(2, 9, off120.lat, off120.lon),
			stay(3, 9, off80.lat, off80.lon),
		];
		const clusters = clusterStays(stays);
		// All four should land in one cluster after merging
		expect(clusters).toHaveLength(1);
		expect(clusters[0].stays).toHaveLength(4);
	});
});

function stay(day: number, hour: number, lat: number, lon: number): Stay {
	const startTs = at(day, hour);
	return {
		startTs,
		endTs: startTs + 1800, // 30 min
		centroidLat: lat,
		centroidLon: lon,
		pointCount: 6,
		durationSec: 1800,
	};
}

function makeCluster(stays: Stay[]): Cluster {
	const totalDwell = stays.reduce((s, x) => s + x.durationSec, 0);
	let cLat = 0;
	let cLon = 0;
	for (const s of stays) {
		cLat += (s.centroidLat * s.durationSec) / totalDwell;
		cLon += (s.centroidLon * s.durationSec) / totalDwell;
	}
	return { id: 1, centroidLat: cLat, centroidLon: cLon, stays, totalDwellSec: totalDwell };
}

describe("classifyCluster", () => {
	it("labels long-running overnight presence as home", () => {
		// 30 nights over 60 days, 8h/night at HOME
		const stays: Stay[] = [];
		for (let d = 0; d < 60; d += 2) {
			const startTs = at(d, 22); // 22:00
			stays.push({
				startTs,
				endTs: startTs + 8 * 3600,
				centroidLat: HOME_LAT,
				centroidLon: HOME_LON,
				pointCount: 8,
				durationSec: 8 * 3600,
			});
		}
		const cls = classifyCluster(makeCluster(stays));
		expect(cls.label).toBe("home");
	});

	it("labels long-running weekday-daytime presence as work", () => {
		// 20 weekday workdays, 9-17 each, no overnight
		const stays: Stay[] = [];
		for (let d = 0; d < 30; d++) {
			const dow = localSolarDayOfWeek(at(d, 12), HOME_LON);
			if (dow > 4) continue; // skip weekends
			const startTs = at(d, 9);
			stays.push({
				startTs,
				endTs: startTs + 8 * 3600,
				centroidLat: HOME_LAT + 0.01,
				centroidLon: HOME_LON + 0.01,
				pointCount: 8,
				durationSec: 8 * 3600,
			});
		}
		const cls = classifyCluster(makeCluster(stays));
		expect(cls.label).toBe("work");
	});

	it("labels short-window overnight presence as hotel", () => {
		// 5 consecutive nights at one place, no other history
		const stays: Stay[] = [];
		for (let d = 0; d < 5; d++) {
			const startTs = at(d, 22);
			stays.push({
				startTs,
				endTs: startTs + 8 * 3600,
				centroidLat: HOME_LAT,
				centroidLon: HOME_LON,
				pointCount: 8,
				durationSec: 8 * 3600,
			});
		}
		const cls = classifyCluster(makeCluster(stays));
		expect(cls.label).toBe("hotel");
	});

	it("labels a single visit as one-off", () => {
		const cls = classifyCluster(makeCluster([stay(0, 14, HOME_LAT, HOME_LON)]));
		expect(cls.label).toBe("one-off");
	});

	it("labels recurring visits over a wide span as frequent", () => {
		// 8 visits across 60 days, each 1h, daytime
		const stays: Stay[] = [];
		for (let d = 0; d < 60; d += 8) {
			const startTs = at(d, 14);
			stays.push({
				startTs,
				endTs: startTs + 3600,
				centroidLat: HOME_LAT,
				centroidLon: HOME_LON,
				pointCount: 6,
				durationSec: 3600,
			});
		}
		const cls = classifyCluster(makeCluster(stays));
		expect(cls.label).toBe("frequent");
	});
});

describe("uniqueDayCount", () => {
	it("counts distinct local days, not stay count", () => {
		// 4 visits all on the same day
		const stays: Stay[] = [
			stay(0, 9, HOME_LAT, HOME_LON),
			stay(0, 12, HOME_LAT, HOME_LON),
			stay(0, 15, HOME_LAT, HOME_LON),
			stay(0, 18, HOME_LAT, HOME_LON),
		];
		expect(uniqueDayCount(stays, HOME_LON)).toBe(1);
	});
});

describe("localSolarHour", () => {
	it("returns local hour from longitude — California is ~8h behind UTC", () => {
		// UTC noon at lon=-120 (Pacific) → ~04:00 local
		const utcNoon = Date.UTC(2026, 0, 1, 12, 0) / 1000;
		expect(localSolarHour(utcNoon, -120)).toBe(4);
	});

	it("returns local hour from longitude — UK is ~0h offset", () => {
		const utcNoon = Date.UTC(2026, 0, 1, 12, 0) / 1000;
		expect(localSolarHour(utcNoon, 0)).toBe(12);
	});
});

describe("assignDisplayNames", () => {
	function homeLikeCluster(id: number): Cluster {
		// 30 nights × 8h, each stay starts 22:00 local and crosses 02:00-06:00
		const stays: Stay[] = [];
		for (let d = 0; d < 60; d += 2) {
			const startTs = at(d, 22);
			stays.push({
				startTs,
				endTs: startTs + 8 * 3600, // ends 06:00 next day — covers deep-night
				centroidLat: HOME_LAT,
				centroidLon: HOME_LON,
				pointCount: 8,
				durationSec: 8 * 3600,
			});
		}
		const totalDwell = stays.reduce((s, x) => s + x.durationSec, 0);
		return { id, centroidLat: HOME_LAT, centroidLon: HOME_LON, stays, totalDwellSec: totalDwell };
	}

	function workLikeCluster(id: number): Cluster {
		// 21 weekday workdays × 8h, no overnight
		const stays: Stay[] = [];
		const workLat = HOME_LAT + 0.05;
		const workLon = HOME_LON + 0.05;
		for (let d = 0; d < 30; d++) {
			if (localSolarDayOfWeek(at(d, 12), workLon) > 4) continue; // skip weekends
			const startTs = at(d, 9);
			stays.push({
				startTs,
				endTs: startTs + 8 * 3600,
				centroidLat: workLat,
				centroidLon: workLon,
				pointCount: 8,
				durationSec: 8 * 3600,
			});
		}
		const totalDwell = stays.reduce((s, x) => s + x.durationSec, 0);
		return { id, centroidLat: workLat, centroidLon: workLon, stays, totalDwellSec: totalDwell };
	}

	it("assigns Home to the cluster with the most overnight + wide span", () => {
		const home = homeLikeCluster(1);
		const names = assignDisplayNames([home]);
		expect(names.get(1)).toBe("Home");
	});

	it("assigns Work to the strongest weekday-daytime cluster (excluding home)", () => {
		const home = homeLikeCluster(1);
		const work = workLikeCluster(2);
		const names = assignDisplayNames([home, work]);
		expect(names.get(1)).toBe("Home");
		expect(names.get(2)).toBe("Work");
	});

	it("returns empty when no cluster qualifies (single short stay)", () => {
		// One 30-min daytime stay — not enough overnight, not enough weekday-daytime
		const s: Stay = stay(0, 14, HOME_LAT, HOME_LON);
		const c: Cluster = { id: 1, centroidLat: HOME_LAT, centroidLon: HOME_LON, stays: [s], totalDwellSec: 1800 };
		expect(assignDisplayNames([c]).size).toBe(0);
	});

	it("does not double-assign — one Home only, even if two clusters look home-like", () => {
		const a = homeLikeCluster(1);
		const b = { ...homeLikeCluster(2), centroidLat: HOME_LAT + 0.1, centroidLon: HOME_LON + 0.1 };
		// Both qualify; only one gets Home, the other becomes Stay
		const names = assignDisplayNames([a, b]);
		expect([...names.values()].filter((v) => v === "Home")).toHaveLength(1);
		expect(names.get(1)).toBe("Home");
		// b still has long-stay history → labelled "Stay" (not null)
		expect(names.get(2)).toBe("Stay");
	});

	it("assigns Stay to a cluster with overnight history that doesn't qualify as Home", () => {
		// 4 weekend overnights — each crosses deep-night
		const stays: Stay[] = [];
		for (const d of [0, 7, 21, 28]) {
			const startTs = at(d, 22);
			stays.push({
				startTs,
				endTs: startTs + 8 * 3600, // 06:00 next day — covers 02:00-06:00
				centroidLat: HOME_LAT,
				centroidLon: HOME_LON,
				pointCount: 6,
				durationSec: 8 * 3600,
			});
		}
		const c: Cluster = {
			id: 1,
			centroidLat: HOME_LAT,
			centroidLon: HOME_LON,
			stays,
			totalDwellSec: 32 * 3600,
		};
		const names = assignDisplayNames([c]);
		expect(names.get(1)).toBe("Stay");
	});

	it("does not assign Stay to a long café visit (no deep-night overlap)", () => {
		// One 6h cafe stay 14:00-20:00 — long, but no overnight presence
		const stays: Stay[] = [
			{
				startTs: at(0, 14),
				endTs: at(0, 14) + 6 * 3600,
				centroidLat: HOME_LAT,
				centroidLon: HOME_LON,
				pointCount: 6,
				durationSec: 6 * 3600,
			},
		];
		const c: Cluster = {
			id: 1,
			centroidLat: HOME_LAT,
			centroidLon: HOME_LON,
			stays,
			totalDwellSec: 6 * 3600,
		};
		const names = assignDisplayNames([c]);
		expect(names.has(1)).toBe(false);
	});

	it("does not assign Stay to a place with only short visits (cafe pattern)", () => {
		const stays: Stay[] = [];
		for (let d = 0; d < 60; d += 8) {
			const startTs = at(d, 14);
			stays.push({
				startTs,
				endTs: startTs + 3600,
				centroidLat: HOME_LAT,
				centroidLon: HOME_LON,
				pointCount: 3,
				durationSec: 3600,
			});
		}
		const c: Cluster = {
			id: 1,
			centroidLat: HOME_LAT,
			centroidLon: HOME_LON,
			stays,
			totalDwellSec: stays.length * 3600,
		};
		const names = assignDisplayNames([c]);
		expect(names.has(1)).toBe(false);
	});
});

describe("detectFocusPlaces", () => {
	it("filters low-accuracy points before stay detection", () => {
		const good = stayPoints(at(0, 9), 30, 5, HOME_LAT, HOME_LON);
		const bad = good.map((p) => ({ ...p, accuracy: 500 }));
		expect(detectFocusPlaces(good).clusters).toHaveLength(1);
		expect(detectFocusPlaces(bad).clusters).toHaveLength(0);
	});

	it("returns clusters sorted by total dwell, descending", () => {
		// One short stay at A, one long stay at B
		const a = stayPoints(at(0, 9), 15, 5, HOME_LAT, HOME_LON);
		const bLatLon = offset(HOME_LAT, HOME_LON, 1000, 0);
		const b = stayPoints(at(1, 9), 240, 5, bLatLon.lat, bLatLon.lon);
		const result = detectFocusPlaces([...a, ...b]);
		expect(result.clusters.length).toBeGreaterThanOrEqual(2);
		expect(result.clusters[0].totalDwellSec).toBeGreaterThan(result.clusters[1].totalDwellSec);
	});
});

describe("pickWinningAmenity", () => {
	// For each cluster we aggregate per-visit OSM amenity lookups across
	// the user's history. Time-weighted: a 2-hour stay at Bairro Alto
	// counts more than a 5-min stop. Picks a clear winner only when the
	// data is decisive — otherwise returns null so the per-visit OSM
	// picker stays in charge as a fallback.

	const opts = { minWeight: 60 * 30, minFraction: 0.5 };

	it("picks the majority-vote amenity when one clearly dominates", () => {
		// 7 visits to Bairro Alto, all 60-min, totaling 7 × 60 = 420 min.
		// 1 noisy visit landed at Kruidentuin (the cannabis shop next door),
		// 15 min. Bairro Alto fraction = 420 / 435 = 97% → wins.
		const votes = new Map<string, number>([
			["Bairro Alto", 7 * 60 * 60],
			["Kruidentuin", 15 * 60],
		]);
		expect(pickWinningAmenity(votes, opts)).toBe("Bairro Alto");
	});

	it("returns null when no amenity has enough total weight", () => {
		// Total under 30 minutes → not enough evidence to commit.
		const votes = new Map<string, number>([["Random Place", 10 * 60]]);
		expect(pickWinningAmenity(votes, opts)).toBeNull();
	});

	it("returns null when the winner is too close to second place (ambiguous)", () => {
		// Cafe A 200min vs Cafe B 180min — 52% / 48%. Below the 50%+
		// fraction-of-total + close to second → not decisive. (The
		// minFraction default of 0.5 means top must exceed half.)
		const votes = new Map<string, number>([
			["Cafe A", 200 * 60],
			["Cafe B", 180 * 60],
		]);
		// 52% just barely passes minFraction. Tighten the gate so a 4%
		// margin is treated as ambiguous.
		const strictOpts = { minWeight: 30 * 60, minFraction: 0.65 };
		expect(pickWinningAmenity(votes, strictOpts)).toBeNull();
	});

	it("returns the only candidate when there's no competition", () => {
		const votes = new Map<string, number>([["Solo Cafe", 90 * 60]]);
		expect(pickWinningAmenity(votes, opts)).toBe("Solo Cafe");
	});

	it("returns null for empty votes", () => {
		expect(pickWinningAmenity(new Map(), opts)).toBeNull();
	});

	it("uses minWeight to prevent picking a name when total is tiny", () => {
		const votes = new Map<string, number>([
			["A", 60 * 5], // 5 minutes total
		]);
		expect(pickWinningAmenity(votes, { minWeight: 60 * 30, minFraction: 0.5 })).toBeNull();
	});
});

describe("hourProfileOf / hourProfileForRange", () => {
	// All test stays sit at lon 0 so local-solar hour == UTC hour and the
	// bucket indices read directly off the UTC clock the `at()` builder uses.
	function lonZeroStay(startTs: number, durationSec: number): Stay {
		return { startTs, endTs: startTs + durationSec, centroidLat: 0, centroidLon: 0, pointCount: 6, durationSec };
	}

	it("puts all weight in one bucket for a stay that stays inside one hour", () => {
		// 13:00–13:50 — every 30-min sample lands in hour 13.
		const c = makeCluster([lonZeroStay(at(0, 13), 50 * 60)]);
		const p = hourProfileOf(c);
		expect(p).toHaveLength(HOUR_BUCKETS);
		expect(p[13]).toBeCloseTo(1, 5);
		expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
	});

	it("spreads weight evenly across the hours a long stay covers", () => {
		// 18:00–23:30 — 30-min samples land 2-per-hour in hours 18..23.
		const c = makeCluster([lonZeroStay(at(0, 18), 5.5 * 3600)]);
		const p = hourProfileOf(c);
		for (let h = 18; h <= 23; h++) expect(p[h]).toBeCloseTo(1 / 6, 5);
		expect(p[12]).toBe(0);
		expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
	});

	it("aggregates a cluster's stays — a daytime visit and an evening visit are both visible", () => {
		// One daytime café-length stay, one long evening stay.
		const c = makeCluster([lonZeroStay(at(0, 14), 60 * 60), lonZeroStay(at(1, 20), 60 * 60)]);
		const p = hourProfileOf(c);
		expect(p[14]).toBeGreaterThan(0);
		expect(p[20]).toBeGreaterThan(0);
		expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
	});

	it("hourProfileForRange buckets a single time range", () => {
		const p = hourProfileForRange(at(0, 9), at(0, 9) + 110 * 60, 0);
		expect(p).toHaveLength(HOUR_BUCKETS);
		expect(p[9]).toBeGreaterThan(0);
		expect(p[10]).toBeGreaterThan(0);
		expect(p[11]).toBe(0);
		expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
	});
});

describe("serializeHourProfile / parseHourProfile", () => {
	it("round-trips a profile through permille serialisation", () => {
		const c = makeCluster([
			{ startTs: at(0, 20), endTs: at(0, 20) + 3600, centroidLat: 0, centroidLon: 0, pointCount: 6, durationSec: 3600 },
		]);
		const profile = hourProfileOf(c);
		const restored = parseHourProfile(serializeHourProfile(profile));
		expect(restored).not.toBeNull();
		for (let h = 0; h < HOUR_BUCKETS; h++) expect(restored?.[h]).toBeCloseTo(profile[h], 2);
	});

	it("serialises to a compact comma-joined string of 24 integers", () => {
		const s = serializeHourProfile(new Array(HOUR_BUCKETS).fill(1 / HOUR_BUCKETS));
		expect(s.split(",")).toHaveLength(HOUR_BUCKETS);
		expect(s.length).toBeLessThan(127);
	});

	it("parseHourProfile returns null for null, empty, or wrong-length input", () => {
		expect(parseHourProfile(null)).toBeNull();
		expect(parseHourProfile("")).toBeNull();
		expect(parseHourProfile("1,2,3")).toBeNull();
	});
});

describe("splitCluster", () => {
	const BASE_LAT = 51.5;
	const BASE_LON = 0; // local solar hour == UTC hour

	// Deterministic pseudo-random in [-1, 1) from an integer seed — keeps
	// the synthetic scatter realistic but the test reproducible.
	function rand(seed: number): number {
		const x = Math.sin(seed * 12.9898) * 43758.5453;
		return 2 * (x - Math.floor(x)) - 1;
	}
	/** A stay on `day` starting near `hour`, `eastM` metres east of base,
	 *  with ±`jitterM` of GPS scatter, lasting `durMin` minutes. */
	function mkStay(seed: number, day: number, hour: number, eastM: number, jitterM: number, durMin: number): Stay {
		const p = offset(BASE_LAT, BASE_LON, rand(seed) * jitterM, eastM + rand(seed + 100) * jitterM);
		const startTs = at(day, hour, Math.floor((rand(seed + 200) + 1) * 25));
		return {
			startTs,
			endTs: startTs + durMin * 60,
			centroidLat: p.lat,
			centroidLon: p.lon,
			pointCount: 8,
			durationSec: durMin * 60,
		};
	}

	it("does not split a single GPS-noisy place (no-regression)", () => {
		// 14 evening visits to one residence — real ±60 m GPS scatter,
		// consistent evening times. A single noisy place must stay one.
		const stays: Stay[] = [];
		for (let i = 0; i < 14; i++) stays.push(mkStay(i, i, 19, 0, 60, 180));
		const result = splitCluster(makeCluster(stays));
		expect(result).toHaveLength(1);
		expect(result[0].stays).toHaveLength(14);
	});

	it("splits a conflated café + residence cluster", () => {
		const stays: Stay[] = [];
		// 6 daytime café visits ~13:00, ~90 min, at base.
		for (let i = 0; i < 6; i++) stays.push(mkStay(i, i, 13, 0, 20, 90));
		// 14 evening residence visits ~20:00, ~5 h, 115 m east.
		for (let i = 0; i < 14; i++) stays.push(mkStay(i + 50, i, 20, 115, 20, 300));
		const result = splitCluster(makeCluster(stays));
		expect(result).toHaveLength(2);
		expect(result.map((c) => c.stays.length).sort((x, y) => x - y)).toEqual([6, 14]);
		// Each lobe is temporally coherent — all daytime or all evening.
		for (const lobe of result) {
			const hours = lobe.stays.map((s) => localSolarHour(s.startTs, BASE_LON));
			const allDaytime = hours.every((h) => h >= 11 && h <= 15);
			const allEvening = hours.every((h) => h >= 18 && h <= 22);
			expect(allDaytime || allEvening).toBe(true);
		}
	});

	it("splits an asymmetric cluster without folding the small 3-visit lobe", () => {
		const stays: Stay[] = [];
		for (let i = 0; i < 14; i++) stays.push(mkStay(i, i, 20, 115, 20, 300));
		for (let i = 0; i < 3; i++) stays.push(mkStay(i + 50, i * 4, 13, 0, 20, 90));
		const result = splitCluster(makeCluster(stays));
		expect(result).toHaveLength(2);
		expect(result.map((c) => c.stays.length).sort((x, y) => x - y)).toEqual([3, 14]);
	});

	it("does not split off a single outlier visit (substantiality floor)", () => {
		const stays: Stay[] = [];
		for (let i = 0; i < 14; i++) stays.push(mkStay(i, i, 20, 0, 50, 180));
		// One lone outlier — far away, different time. Its lobe is 1 day.
		stays.push(mkStay(99, 7, 4, 400, 5, 120));
		expect(splitCluster(makeCluster(stays))).toHaveLength(1);
	});

	it("does not split a cluster with too few unique days", () => {
		// Three visit-days cannot form two lobes of ≥ SPLIT_MIN_LOBE_DAYS each.
		const stays: Stay[] = [];
		for (let i = 0; i < 3; i++) stays.push(mkStay(i, i, 13, 0, 20, 90));
		expect(splitCluster(makeCluster(stays))).toHaveLength(1);
	});
});
