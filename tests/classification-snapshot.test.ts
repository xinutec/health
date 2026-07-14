/**
 * Classification snapshot — the committable CI net for factor-scorer
 * changes (#103).
 *
 * Each scenario is a synthetic day driven through the full
 * `computeVelocityFromInputs` core; the test pins the per-segment
 * `(mode, wayName)` sequence with an inline snapshot. Every scenario runs
 * under BOTH flag states:
 *
 *   - "legacy cascade"   — `USE_FACTOR_SCORER` unset (today's production)
 *   - "factor scorer ON" — `USE_FACTOR_SCORER=1` (the migration target)
 *
 * The paired snapshots are the migration's calibration instrument: the
 * legacy column is the frozen baseline, the scorer column shows what
 * flipping the flag would do, and a diff in either is an explicit,
 * reviewable segment-level change rather than a silent shift in the
 * rendered timeline. The canonical reason the migration exists:
 *
 *   - a motorised leg hugging a rail line with no road near → train
 *   - the same speed on a road with no rail near            → driving
 *
 * Speed alone can't separate them; only the map (the rail-corridor
 * factor, live only under the flag) can.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Station } from "../src/geo/line-stations.js";
import type { NearbyStation, NearbyWay } from "../src/geo/osm.js";
import type { OsmAdapter } from "../src/geo/osm-adapter.js";
import { computeVelocityFromInputs } from "../src/geo/velocity.js";
import { segmentSnapshot, synthInputs } from "./helpers/classification-snapshot.js";
import { mockOsmAdapter } from "./helpers/mock-osm-adapter.js";
import { moveBearing, type SynthDay, synthDay, tsAt } from "./scenarios/synth-day.js";

const START = tsAt("2026-06-01T09:00:00Z");

/** A named scenario: a synthetic day + the OSM evidence around it. */
interface Scenario {
	day: SynthDay;
	osm: OsmAdapter;
}

/** A motorised 63 km/h leg, 8 minutes due east from a synthetic anchor. */
function motorisedLeg(): SynthDay {
	return synthDay(START, [
		moveBearing({ durationSec: 8 * 60, from: [51.5, -0.1], speedKmh: 63, headingDeg: 90, hr: 88, cadence: 0 }),
	]);
}

/** Motorised leg hugging a subway, with stations in range (the rail-run
 *  rescue can fire). */
function tubeWithStations(): Scenario {
	const subway: NearbyWay = { type: "railway", subtype: "subway", name: "Test Line", distanceM: 14 };
	const board: Station = { name: "Alpha", lat: 51.5, lon: -0.1 };
	const alight: Station = { name: "Omega", lat: 51.5, lon: -0.1 + 0.12 };
	return {
		day: motorisedLeg(),
		osm: mockOsmAdapter({
			nearbyWays: () => [subway],
			linesAtPoint: () => new Set(["Test Line"]),
			stationsOnLine: () => [board, alight],
			nearbyStations: (lat, lon): NearbyStation[] => {
				const near = (s: Station) => Math.hypot((lat - s.lat) * 111_000, (lon - s.lon) * 70_000) < 400;
				return [board, alight].filter(near).map((s) => ({ name: s.name, subtype: "subway", distanceM: 50 }));
			},
		}),
	};
}

/** Motorised leg on a road, no rail anywhere. */
function driveOnRoad(): Scenario {
	const road: NearbyWay = { type: "highway", subtype: "primary", name: "Test Road", distanceM: 9 };
	return { day: motorisedLeg(), osm: mockOsmAdapter({ nearbyWays: () => [road] }) };
}

/** The migration's target case: rail AND road both near, no station in
 *  range, so the rail-run rescue can't fire — only the relative proximity
 *  (rail-corridor factor) can break the tie. */
function railAndRoadAmbiguity(): Scenario {
	const subway: NearbyWay = { type: "railway", subtype: "subway", name: "Test Line", distanceM: 16 };
	const road: NearbyWay = { type: "highway", subtype: "primary", name: "Test Road", distanceM: 22 };
	return { day: motorisedLeg(), osm: mockOsmAdapter({ nearbyWays: () => [road, subway] }) };
}

/** A walking leg on a footway. */
function walkOnFootway(): Scenario {
	const footway: NearbyWay = { type: "highway", subtype: "footway", name: "Test Path", distanceM: 4 };
	return {
		day: synthDay(START, [
			moveBearing({ durationSec: 12 * 60, from: [51.5, -0.1], speedKmh: 5, headingDeg: 90, hr: 102, cadence: 110 }),
		]),
		osm: mockOsmAdapter({ nearbyWays: () => [footway] }),
	};
}

async function snapshotOf(scenario: Scenario): Promise<string[]> {
	const { segments } = await computeVelocityFromInputs(synthInputs(scenario.day, scenario.osm));
	return segmentSnapshot(segments);
}

describe("classification snapshot — legacy cascade (USE_FACTOR_SCORER unset)", () => {
	it("tube hugging a subway, stations in range → train", async () => {
		expect(await snapshotOf(tubeWithStations())).toMatchInlineSnapshot(`
			[
			  "driving→train · Test Line",
			]
		`);
	});

	it("same speed on a road, no rail near → driving", async () => {
		expect(await snapshotOf(driveOnRoad())).toMatchInlineSnapshot(`
			[
			  "driving · Test Road",
			]
		`);
	});

	it("rail and road both near, no stations → the genuine ambiguity", async () => {
		expect(await snapshotOf(railAndRoadAmbiguity())).toMatchInlineSnapshot(`
			[
			  "driving→train · Test Line",
			]
		`);
	});

	it("walking leg on a footway → walking", async () => {
		expect(await snapshotOf(walkOnFootway())).toMatchInlineSnapshot(`
			[
			  "walking · Test Path",
			]
		`);
	});
});

describe("classification snapshot — factor scorer ON (USE_FACTOR_SCORER=1)", () => {
	beforeEach(() => {
		vi.stubEnv("USE_FACTOR_SCORER", "1");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("tube hugging a subway, stations in range → train", async () => {
		expect(await snapshotOf(tubeWithStations())).toMatchInlineSnapshot(`
			[
			  "driving→train · Test Line",
			]
		`);
	});

	it("same speed on a road, no rail near → driving", async () => {
		expect(await snapshotOf(driveOnRoad())).toMatchInlineSnapshot(`
			[
			  "driving · Test Road",
			]
		`);
	});

	it("rail and road both near, no stations → the genuine ambiguity", async () => {
		expect(await snapshotOf(railAndRoadAmbiguity())).toMatchInlineSnapshot(`
			[
			  "driving→train · Test Line",
			]
		`);
	});

	it("walking leg on a footway → walking", async () => {
		expect(await snapshotOf(walkOnFootway())).toMatchInlineSnapshot(`
			[
			  "walking · Test Path",
			]
		`);
	});
});
