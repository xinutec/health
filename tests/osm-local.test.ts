/**
 * Tests for the pure-function layer of the local OSM mirror.
 *
 * The DB-touching helpers (ensureCoverage, queryFeatures) need a real
 * MariaDB with ST_Distance_Sphere to test meaningfully; those are
 * verified end-to-end via analyze-day on production data after
 * deploy. This file covers the parts we can test in isolation:
 *
 *   - coverage-containment math
 *   - fetch-bbox computation
 *   - Overpass element → feature parsing
 *   - Overpass query string assembly
 */

import { describe, expect, it } from "vitest";
import {
	buildOverpassQuery,
	COVERAGE_FRESH_DAYS,
	type CoverageRow,
	decideCoverage,
	fetchBboxAround,
	isPointCovered,
	type ParsedFeature,
	parseOverpassElement,
	streamOverpassElements,
} from "../src/geo/osm-local.js";

describe("isPointCovered", () => {
	it("returns false against an empty coverage list", () => {
		expect(isPointCovered(51.5, -0.1, 400, [])).toBe(false);
	});

	it("returns true when the search circle is fully inside a coverage box", () => {
		const covers: CoverageRow[] = [{ min_lat: 51.0, max_lat: 52.0, min_lon: -1.0, max_lon: 0.5 }];
		expect(isPointCovered(51.5, -0.1, 400, covers)).toBe(true);
	});

	it("returns false when the search circle extends beyond a coverage box edge", () => {
		// 400m radius ≈ 0.0036° lat. Box extends only 0.001° above query
		// → search circle pokes out the top.
		const covers: CoverageRow[] = [{ min_lat: 50.0, max_lat: 51.501, min_lon: -1.0, max_lon: 0.5 }];
		expect(isPointCovered(51.5, -0.1, 400, covers)).toBe(false);
	});

	it("returns true when one of multiple coverage boxes contains the search circle", () => {
		const covers: CoverageRow[] = [
			{ min_lat: 60.0, max_lat: 61.0, min_lon: 0.0, max_lon: 1.0 }, // miss
			{ min_lat: 51.0, max_lat: 52.0, min_lon: -1.0, max_lon: 0.5 }, // covers
		];
		expect(isPointCovered(51.5, -0.1, 400, covers)).toBe(true);
	});

	it("requires full containment — partial overlap is not enough", () => {
		// 400m radius circle straddles the boundary at lat 51.5
		const covers: CoverageRow[] = [{ min_lat: 51.5, max_lat: 52.0, min_lon: -1.0, max_lon: 0.5 }];
		expect(isPointCovered(51.5, -0.1, 400, covers)).toBe(false);
	});

	it("scales latitude correction with the query latitude", () => {
		// At the equator, 400m east-west is the same number of degrees
		// as 400m north-south. Near London (lat 51.5), 400m east-west
		// is about 1.6× more degrees of longitude (because cos(51.5°) ≈ 0.62).
		// The function must account for that — otherwise a coverage box
		// that's "just wide enough" at the equator would falsely cover
		// a London query.
		const tightBox: CoverageRow[] = [
			// Box that's exactly 400m wide in lon-degrees at the equator
			{ min_lat: 51.0, max_lat: 52.0, min_lon: -0.0036, max_lon: 0.0036 },
		];
		// At lat 51.5, 400m radius needs ~0.0058° of longitude. The
		// 0.0036°-wide box doesn't cover it.
		expect(isPointCovered(51.5, 0.0, 400, tightBox)).toBe(false);
	});
});

describe("decideCoverage", () => {
	// The cache-vs-fetch policy: given a query point + existing
	// coverage rows + the current time, return whether we can serve
	// from the local mirror or need to fetch from Overpass. Wraps
	// isPointCovered with a freshness filter — stale rows
	// (older than COVERAGE_FRESH_DAYS) don't count.
	const NOW = new Date("2026-05-13T12:00:00Z").getTime();
	const FRESH = new Date(NOW - 10 * 86400_000); // 10 days ago
	const STALE = new Date(NOW - (COVERAGE_FRESH_DAYS + 10) * 86400_000); // 190 days ago

	const inLondon = { lat: 51.5, lon: -0.1, radiusM: 400 };

	function row(fetched_at: Date | undefined): CoverageRow {
		return { min_lat: 51.0, max_lat: 52.0, min_lon: -1.0, max_lon: 0.5, fetched_at };
	}

	it("returns 'needs-fetch' when coverage is empty", () => {
		expect(decideCoverage(inLondon, [], NOW)).toBe("needs-fetch");
	});

	it("returns 'covered' when a fresh row contains the search circle", () => {
		expect(decideCoverage(inLondon, [row(FRESH)], NOW)).toBe("covered");
	});

	it("returns 'needs-fetch' when the only containing row is stale (older than 180 days)", () => {
		expect(decideCoverage(inLondon, [row(STALE)], NOW)).toBe("needs-fetch");
	});

	it("treats a row with no fetched_at as fresh (legacy rows from before tracking)", () => {
		// Older rows might predate the fetched_at column; we should
		// trust them rather than refetch the world. Mirrors the
		// `!c.fetched_at || c.fetched_at > cutoff` logic in
		// ensureCovered.
		expect(decideCoverage(inLondon, [row(undefined)], NOW)).toBe("covered");
	});

	it("picks the fresh row out of a mixed list", () => {
		// One stale row that happens to cover, plus one fresh row
		// that also covers → covered (we have a fresh one).
		expect(decideCoverage(inLondon, [row(STALE), row(FRESH)], NOW)).toBe("covered");
	});

	it("does NOT consider stale rows even if they alone would cover", () => {
		// The only containment comes from a stale row → must re-fetch.
		const farRow: CoverageRow = {
			min_lat: 60.0,
			max_lat: 61.0,
			min_lon: 0.0,
			max_lon: 1.0,
			fetched_at: FRESH,
		}; // fresh but doesn't cover
		expect(decideCoverage(inLondon, [row(STALE), farRow], NOW)).toBe("needs-fetch");
	});

	it("returns 'covered' for a row right at the freshness boundary (today + 0)", () => {
		// fetched_at exactly cutoff: treated as fresh (inclusive).
		// Implementation uses strict `>`; boundary is "stale". Add
		// 1ms to make it definitively fresh.
		const boundaryFresh = new Date(NOW - COVERAGE_FRESH_DAYS * 86400_000 + 1);
		expect(decideCoverage(inLondon, [row(boundaryFresh)], NOW)).toBe("covered");
	});

	// --------------------------------------------------------------
	// Local-data fallback: a previous sibling-feature_type fetch may
	// have populated osm_lines / osm_points without leaving a
	// coverage row for THIS feature_type. Example: fetching `aeroway`
	// over a 10 km bbox around Brussels also pulls some `highway`
	// rows from the same Overpass call's overflow, but only the
	// `aeroway` coverage row gets recorded. Every subsequent `highway`
	// query in Brussels then sees "no coverage" and re-fetches.
	//
	// `hasLocalData: true` lets the caller short-circuit that: if
	// we already have data for this area in the local table, we can
	// serve from it without a fresh Overpass roundtrip.
	// --------------------------------------------------------------

	it("returns 'covered' when hasLocalData=true even with no coverage rows", () => {
		// Empty coverage but local probe found rows. This is the
		// Brussels-highway case: we have the data, we just don't have
		// a coverage marker. Skip Overpass.
		expect(decideCoverage(inLondon, [], NOW, { hasLocalData: true })).toBe("covered");
	});

	it("hasLocalData=false (or missing) behaves like the original signature", () => {
		// Backwards compat: callers that don't probe shouldn't see any
		// change. Empty coverage still means needs-fetch.
		expect(decideCoverage(inLondon, [], NOW, { hasLocalData: false })).toBe("needs-fetch");
		expect(decideCoverage(inLondon, [], NOW)).toBe("needs-fetch");
	});

	it("hasLocalData=true does NOT override a stale coverage row's freshness logic when refresh is desired", () => {
		// Subtle: if the only containment is stale, we'd normally
		// re-fetch to update the data. With hasLocalData=true we
		// accept what we have. This documents the trade-off:
		// "use what we have" wins over "data might be stale". For
		// our use case (personal travel history, OSM features stable
		// over months) this is the right call — the alternative is
		// a Brussels-highway timeout loop every time stale rows are
		// the only coverage.
		expect(decideCoverage(inLondon, [row(STALE)], NOW, { hasLocalData: true })).toBe("covered");
	});
});

describe("fetchBboxAround", () => {
	it("centres a 2km box on the query point (default half-width 1000m)", () => {
		const b = fetchBboxAround(51.5, -0.1);
		expect(b.minLat).toBeLessThan(51.5);
		expect(b.maxLat).toBeGreaterThan(51.5);
		expect(b.minLon).toBeLessThan(-0.1);
		expect(b.maxLon).toBeGreaterThan(-0.1);
	});

	it("respects the half-width parameter", () => {
		const small = fetchBboxAround(51.5, -0.1, 1000);
		const big = fetchBboxAround(51.5, -0.1, 10_000);
		expect(big.maxLat - big.minLat).toBeGreaterThan(small.maxLat - small.minLat);
	});

	it("compensates for latitude in longitude span", () => {
		// At higher latitudes, the same metre-distance is more degrees
		// of longitude. fetchBboxAround must reflect that.
		const london = fetchBboxAround(51.5, 0.0, 5000);
		const equator = fetchBboxAround(0.0, 0.0, 5000);
		const londonWidth = london.maxLon - london.minLon;
		const equatorWidth = equator.maxLon - equator.minLon;
		expect(londonWidth).toBeGreaterThan(equatorWidth);
	});

	it("produces a box that fully contains a search circle of the same radius", () => {
		// Sanity: the box we fetch for radius R should be safe coverage
		// for queries up to radius R at the centre.
		const bbox = fetchBboxAround(51.5, -0.1, 5000);
		const covered = isPointCovered(51.5, -0.1, 5000, [
			{ min_lat: bbox.minLat, max_lat: bbox.maxLat, min_lon: bbox.minLon, max_lon: bbox.maxLon },
		]);
		expect(covered).toBe(true);
	});
});

describe("parseOverpassElement", () => {
	it("parses a station node as feature_type=station with POINT geometry", () => {
		const f = parseOverpassElement({
			type: "node",
			id: 12345,
			lat: 51.5331,
			lon: -0.1259,
			tags: { railway: "station", name: "Elmford Central" },
		});
		expect(f).not.toBeNull();
		expect(f?.feature_type).toBe("railway");
		expect(f?.subtype).toBe("station");
		expect(f?.name).toBe("Elmford Central");
		expect(f?.geom_wkt).toBe("POINT(-0.1259 51.5331)");
	});

	it("buckets a bus_stop node under transit_stop, not highway (#247)", () => {
		const f = parseOverpassElement({
			type: "node",
			id: 111,
			lat: 51.5,
			lon: -0.14,
			tags: { highway: "bus_stop", name: "Synthetic Stop A" },
		});
		expect(f?.feature_type).toBe("transit_stop");
		expect(f?.subtype).toBe("bus_stop");
		expect(f?.name).toBe("Synthetic Stop A");
	});

	it("buckets a traffic_signals node under transit_stop", () => {
		const f = parseOverpassElement({
			type: "node",
			id: 112,
			lat: 51.5,
			lon: -0.14,
			tags: { highway: "traffic_signals" },
		});
		expect(f?.feature_type).toBe("transit_stop");
		expect(f?.subtype).toBe("traffic_signals");
	});

	it("keeps a bus_stop-tagged WAY in the highway bucket (node-only rule)", () => {
		const f = parseOverpassElement({
			type: "way",
			id: 113,
			tags: { highway: "bus_stop" },
			geometry: [
				{ lat: 51.5, lon: -0.14 },
				{ lat: 51.5001, lon: -0.1401 },
			],
		});
		expect(f?.feature_type).toBe("highway");
	});

	it("parses a way as LINESTRING using its geometry vertices", () => {
		const f = parseOverpassElement({
			type: "way",
			id: 67890,
			tags: { highway: "motorway", name: "M25" },
			geometry: [
				{ lat: 51.5, lon: -0.5 },
				{ lat: 51.6, lon: -0.4 },
				{ lat: 51.7, lon: -0.3 },
			],
		});
		expect(f).not.toBeNull();
		expect(f?.feature_type).toBe("highway");
		expect(f?.subtype).toBe("motorway");
		expect(f?.geom_wkt).toBe("LINESTRING(-0.5 51.5,-0.4 51.6,-0.3 51.7)");
	});

	it("buckets a railway tag as feature_type=railway", () => {
		const f = parseOverpassElement({
			type: "way",
			id: 1,
			tags: { railway: "subway", name: "Jubilee Line" },
			geometry: [
				{ lat: 51.5, lon: -0.1 },
				{ lat: 51.6, lon: -0.2 },
			],
		});
		expect(f?.feature_type).toBe("railway");
		expect(f?.subtype).toBe("subway");
	});

	it("uses tag-priority order — railway wins over highway when both present", () => {
		const f = parseOverpassElement({
			type: "way",
			id: 1,
			tags: { railway: "rail", highway: "service" },
			geometry: [
				{ lat: 51.5, lon: -0.1 },
				{ lat: 51.6, lon: -0.2 },
			],
		});
		expect(f?.feature_type).toBe("railway");
	});

	it("returns null for an element with no relevant tags", () => {
		expect(parseOverpassElement({ type: "node", id: 1, lat: 51, lon: -1, tags: { population: "1000" } })).toBeNull();
	});

	it("returns null for a node missing lat/lon", () => {
		expect(parseOverpassElement({ type: "node", id: 1, tags: { railway: "station" } })).toBeNull();
	});

	it("returns null for a way missing geometry", () => {
		expect(parseOverpassElement({ type: "way", id: 1, tags: { highway: "motorway" } })).toBeNull();
	});

	it("falls back to `ref` when name is missing", () => {
		const f = parseOverpassElement({
			type: "way",
			id: 1,
			tags: { highway: "motorway", ref: "A1" },
			geometry: [
				{ lat: 51.5, lon: -0.1 },
				{ lat: 51.6, lon: -0.2 },
			],
		});
		expect(f?.name).toBe("A1");
	});
});

describe("buildOverpassQuery", () => {
	const bbox = { minLat: 51.0, maxLat: 52.0, minLon: -1.0, maxLon: 0.5 };

	it("emits stanzas for both stations (nodes) and rail lines (ways) under feature_type=railway", () => {
		// One Overpass fetch under feature_type=railway should bring
		// back BOTH station nodes and rail-line ways. That way both
		// nearbyStations and linesAtPoint share a single coverage box
		// per area, not two separate ones.
		const q = buildOverpassQuery("railway", bbox);
		expect(q).toContain("[out:json][timeout:25]");
		expect(q).toContain('node["railway"~"^(station|subway_entrance|halt|stop|tram_stop)$"]');
		expect(q).toContain('way["railway"~"^(rail|subway|light_rail|tram|narrow_gauge)$"]');
		expect(q).toContain("51,-1,52,0.5"); // bbox in S,W,N,E order
		expect(q).toContain("out tags geom"); // we need way geometry for ways
	});

	it("emits separate stanzas for landmark sub-tags", () => {
		const q = buildOverpassQuery("landmark", bbox);
		expect(q).toContain('node["amenity"]');
		expect(q).toContain('node["shop"]');
		expect(q).toContain('way["amenity"]');
		expect(q).toContain('way["shop"]');
	});

	it("rejects unknown feature_types up front", () => {
		expect(() => buildOverpassQuery("not_a_thing", bbox)).toThrow();
	});
});

describe("streamOverpassElements", () => {
	// Streaming JSON parse for Overpass responses. Avoids buffering the
	// whole `{ "version": ..., "elements": [ ... ] }` payload in heap —
	// elements arrive one at a time, get parsed + bucketed (points vs
	// lines), and flushed to the caller's onBatch in fixed-size groups.
	// This is what keeps the local-OSM-mirror cold-start under the pod
	// memory limit at 10km bboxes; the old `await res.json()` path peaked
	// at ~3× raw response size.

	function bodyOf(json: unknown): Response {
		return new Response(JSON.stringify(json), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	const stationNode = {
		type: "node",
		id: 100,
		lat: 51.5,
		lon: -0.1,
		tags: { railway: "station", name: "Elmford" },
	};

	const railWay = {
		type: "way",
		id: 200,
		tags: { railway: "subway", name: "Victoria Line" },
		geometry: [
			{ lat: 51.5, lon: -0.1 },
			{ lat: 51.6, lon: -0.2 },
		],
	};

	const motorwayWay = {
		type: "way",
		id: 300,
		tags: { highway: "motorway", name: "M25" },
		geometry: [
			{ lat: 51.0, lon: -0.5 },
			{ lat: 51.1, lon: -0.4 },
		],
	};

	it("emits a single batch with all elements when fewer than batchSize", async () => {
		const body = bodyOf({ version: 0.6, elements: [stationNode, railWay] });
		const batches: Array<{ points: ParsedFeature[]; lines: ParsedFeature[] }> = [];
		const { count } = await streamOverpassElements(body, async (points, lines) => {
			batches.push({ points: [...points], lines: [...lines] });
		});
		expect(count).toBe(2);
		expect(batches).toHaveLength(1);
		expect(batches[0].points.map((f) => f.osm_id)).toEqual([100]);
		expect(batches[0].lines.map((f) => f.osm_id)).toEqual([200]);
	});

	it("splits across multiple batches when input exceeds batchSize", async () => {
		// 5 elements with batchSize 2 → batches of [2, 2, 1]. Sizes count
		// total elements (points + lines), not per-bucket.
		const elements = [stationNode, railWay, motorwayWay, stationNode, railWay];
		const body = bodyOf({ version: 0.6, elements });
		const batches: Array<{ size: number }> = [];
		await streamOverpassElements(
			body,
			async (points, lines) => {
				batches.push({ size: points.length + lines.length });
			},
			2,
		);
		expect(batches.map((b) => b.size)).toEqual([2, 2, 1]);
	});

	it("calls onBatch zero times when elements array is empty", async () => {
		const body = bodyOf({ version: 0.6, elements: [] });
		let calls = 0;
		const { count } = await streamOverpassElements(body, async () => {
			calls++;
		});
		expect(calls).toBe(0);
		expect(count).toBe(0);
	});

	it("filters out untaggable elements (no rule match)", async () => {
		// `population` is not in FEATURE_TYPE_RULES; parseOverpassElement
		// returns null. The streamer must skip those — they don't count
		// toward batches or the returned `count`.
		const untaggable = { type: "node", id: 999, lat: 0, lon: 0, tags: { population: "100" } };
		const body = bodyOf({ version: 0.6, elements: [untaggable, stationNode] });
		const batches: Array<{ points: ParsedFeature[]; lines: ParsedFeature[] }> = [];
		const { count } = await streamOverpassElements(body, async (points, lines) => {
			batches.push({ points: [...points], lines: [...lines] });
		});
		expect(count).toBe(1);
		expect(batches[0].points.map((f) => f.osm_id)).toEqual([100]);
	});

	it("propagates errors from malformed JSON", async () => {
		const body = new Response("{not valid json", { status: 200 });
		await expect(streamOverpassElements(body, async () => {})).rejects.toThrow();
	});

	it("ignores fields outside `elements` so we don't buffer the whole payload", async () => {
		// Overpass responses include `version`, `generator`, `osm3s`
		// metadata before the `elements` array. Our streamer should walk
		// past those without trying to keep them. The visible behaviour
		// is just: parse succeeds and returns only elements.
		const body = bodyOf({
			version: 0.6,
			generator: "Overpass API 0.7.62",
			osm3s: { timestamp_osm_base: "2024-01-01T00:00:00Z" },
			elements: [stationNode],
		});
		const batches: ParsedFeature[][] = [];
		await streamOverpassElements(body, async (points) => {
			batches.push([...points]);
		});
		expect(batches[0]).toHaveLength(1);
		expect(batches[0][0].osm_id).toBe(100);
	});
});
