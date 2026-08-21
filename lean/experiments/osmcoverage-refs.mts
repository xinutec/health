#!/usr/bin/env -S npx tsx
/**
 * Derive `#guard` expectations for `Verified.Geo.OsmCoverage` from V8.
 *
 * `decideCoverage` is the gate in front of every OSM lookup: "covered" serves
 * from the local mirror, "needs-fetch" goes to Overpass. A Rust host that reads
 * the mirror WITHOUT this gate cannot tell an area with no roads from an area
 * nobody has fetched yet — it would answer "no ways here", which is a claim
 * rather than an absence (health #976, and the trap #982 records).
 *
 * The rules are small and each one is easy to get silently wrong:
 *   - the search CIRCLE is approximated by its bounding box, conservatively;
 *   - a single row must contain the whole box — two rows that jointly cover it
 *     do NOT count, because there is no union logic;
 *   - boxes are INCLUSIVE at both ends;
 *   - a row older than COVERAGE_FRESH_DAYS is excluded BEFORE the containment
 *     check, so a stale row cannot suppress a refresh;
 *   - a row with no `fetched_at` is treated as FRESH, not as stale — legacy
 *     data from before tracking;
 *   - `hasLocalData` short-circuits everything, including staleness.
 *
 * So the expectations below are what the REAL `src/geo/osm-local.ts` does under
 * Node, printed for pasting into the Lean twin verbatim. None of them is a
 * number reasoned to.
 *
 * Run: npx tsx lean/experiments/osmcoverage-refs.mts
 */
import { COVERAGE_FRESH_DAYS, type CoverageRow, decideCoverage, isPointCovered, metersPerDegLon } from "../../src/geo/osm-local.js";

const NOW = 1_700_000_000_000; // fixed, so the guards do not move with the clock
const day = 86_400_000;
const row = (minLat: number, maxLat: number, minLon: number, maxLon: number, ageDays?: number): CoverageRow => ({
	min_lat: minLat,
	max_lat: maxLat,
	min_lon: minLon,
	max_lon: maxLon,
	...(ageDays === undefined ? {} : { fetched_at: new Date(NOW - ageDays * day) }),
});

// A box comfortably around (51.5, -0.1), and one that only just contains the
// search bbox for radius 500 at that latitude.
const big = row(51.0, 52.0, -1.0, 1.0, 1);
const stale = row(51.0, 52.0, -1.0, 1.0, COVERAGE_FRESH_DAYS + 1);
const legacy = row(51.0, 52.0, -1.0, 1.0); // no fetched_at
const dLat = 500 / 111_000;
const dLon = 500 / metersPerDegLon(51.5);
const exact = row(51.5 - dLat, 51.5 + dLat, -0.1 - dLon, -0.1 + dLon, 1);
const west = row(51.0, 52.0, -1.0, -0.1, 1);
const east = row(51.0, 52.0, -0.1, 1.0, 1);

const cases: Array<[string, () => boolean]> = [
	["hasLocalData short-circuits an EMPTY coverage list", () => decideCoverage({ lat: 51.5, lon: -0.1, radiusM: 500 }, [], NOW, { hasLocalData: true }) === "covered"],
	["hasLocalData short-circuits a STALE row", () => decideCoverage({ lat: 51.5, lon: -0.1, radiusM: 500 }, [stale], NOW, { hasLocalData: true }) === "covered"],
	["no rows at all", () => decideCoverage({ lat: 51.5, lon: -0.1, radiusM: 500 }, [], NOW) === "covered"],
	["one fresh containing row", () => decideCoverage({ lat: 51.5, lon: -0.1, radiusM: 500 }, [big], NOW) === "covered"],
	["the same row, stale", () => decideCoverage({ lat: 51.5, lon: -0.1, radiusM: 500 }, [stale], NOW) === "covered"],
	["the same row, no fetched_at", () => decideCoverage({ lat: 51.5, lon: -0.1, radiusM: 500 }, [legacy], NOW) === "covered"],
	["radius pokes outside the row", () => decideCoverage({ lat: 51.5, lon: -0.1, radiusM: 500_000 }, [big], NOW) === "covered"],
	["two rows that JOINTLY cover, neither alone", () => decideCoverage({ lat: 51.5, lon: -0.1, radiusM: 500 }, [west, east], NOW) === "covered"],
	["a row exactly equal to the search bbox (inclusive)", () => decideCoverage({ lat: 51.5, lon: -0.1, radiusM: 500 }, [exact], NOW) === "covered"],
	["isPointCovered directly, containing", () => isPointCovered(51.5, -0.1, 500, [big])],
	["isPointCovered directly, exact", () => isPointCovered(51.5, -0.1, 500, [exact])],
	["isPointCovered at high latitude (dLon >> dLat)", () => isPointCovered(70.0, 20.0, 500, [row(69.9, 70.1, 19.9, 20.1, 1)])],
];

console.log(`COVERAGE_FRESH_DAYS = ${COVERAGE_FRESH_DAYS}`);
console.log(`metersPerDegLon(51.5) = ${metersPerDegLon(51.5)}`);
console.log(`metersPerDegLon(70)   = ${metersPerDegLon(70)}`);
for (const [name, f] of cases) console.log(`${f() ? "covered    " : "needs-fetch"}  ${name}`);
