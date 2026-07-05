/**
 * Phase 6e adapter tests: capture+replay round-trips correctly, and
 * `FixtureOsmAdapter` throws on uncaptured queries.
 *
 * Setup: a `MockOsmAdapter` (Phase 6d test helper) plays the role of
 * `DbOsmAdapter`. `RecordingOsmAdapter` wraps the mock and is driven
 * through a sequence of calls; the resulting trace then feeds a
 * `FixtureOsmAdapter`, which replays the same calls and is asserted
 * to produce identical output.
 */

import { describe, expect, it } from "vitest";
import { FixtureOsmAdapter } from "../src/geo/osm-adapter-fixture.js";
import { emptyOsmTrace, RecordingOsmAdapter } from "../src/geo/osm-adapter-recording.js";
import { mockOsmAdapter } from "./helpers/mock-osm-adapter.js";

describe("RecordingOsmAdapter", () => {
	it("delegates to the inner adapter and records the result by (lat, lon, radius)", async () => {
		const inner = mockOsmAdapter({
			nearbyWays: () => [{ type: "highway", subtype: "primary", name: "A1", distanceM: 12 }],
		});
		const rec = new RecordingOsmAdapter(inner);

		const result = await rec.nearbyWays(51.5, -0.1, 50);
		expect(result).toEqual([{ type: "highway", subtype: "primary", name: "A1", distanceM: 12 }]);
		expect(rec.trace.nearbyWays["51.5|-0.1|50"]).toEqual(result);
	});

	it("records all five primitives", async () => {
		const inner = mockOsmAdapter({
			nearbyStations: () => [{ name: "Elmford", subtype: "rail", distanceM: 8 }],
			nearbyLandmarks: () => [{ name: "British Library", type: "amenity", subtype: "library", distanceM: 15 }],
			linesAtPoint: () => new Set(["Northern Line", "Victoria Line"]),
			reverseGeocode: () => ({
				displayName: "Elmford, London",
				type: "station",
				category: "railway",
				address: { city: "Greater London" },
			}),
		});
		const rec = new RecordingOsmAdapter(inner);

		await rec.nearbyWays(51.531, -0.124, 50);
		await rec.nearbyStations(51.531, -0.124, 400);
		await rec.nearbyLandmarks(51.531, -0.124, 100);
		await rec.linesAtPoint(51.531, -0.124, 100);
		await rec.reverseGeocode(51.531, -0.124, 18);

		expect(Object.keys(rec.trace.nearbyWays)).toHaveLength(1);
		expect(Object.keys(rec.trace.nearbyStations)).toHaveLength(1);
		expect(Object.keys(rec.trace.nearbyLandmarks)).toHaveLength(1);
		expect(Object.keys(rec.trace.linesAtPoint)).toHaveLength(1);
		expect(Object.keys(rec.trace.reverseGeocode)).toHaveLength(1);
		// Set<string> serialises as string[] for fixture JSON round-trip.
		expect(rec.trace.linesAtPoint["51.531|-0.124|100"]).toEqual(["Northern Line", "Victoria Line"]);
	});

	it("uses an empty string segment when the optional third arg is omitted", async () => {
		const inner = mockOsmAdapter({ nearbyWays: () => [] });
		const rec = new RecordingOsmAdapter(inner);
		await rec.nearbyWays(51.5, -0.1);
		expect(rec.trace.nearbyWays["51.5|-0.1|"]).toEqual([]);
	});

	it("overwrites same-key entries (idempotent prod cache → last-call wins)", async () => {
		let nthCall = 0;
		const inner = mockOsmAdapter({
			nearbyWays: () => {
				nthCall++;
				return [{ type: "highway", subtype: nthCall === 1 ? "primary" : "secondary", distanceM: 5 }];
			},
		});
		const rec = new RecordingOsmAdapter(inner);

		await rec.nearbyWays(51.5, -0.1, 50);
		await rec.nearbyWays(51.5, -0.1, 50);

		// Last call wins.
		expect(rec.trace.nearbyWays["51.5|-0.1|50"]?.[0].subtype).toBe("secondary");
	});
});

describe("FixtureOsmAdapter — exact-key replay", () => {
	it("replays a recorded call byte-identically", async () => {
		const inner = mockOsmAdapter({
			nearbyWays: () => [{ type: "highway", subtype: "primary", name: "Holloway Rd", distanceM: 12 }],
		});
		const rec = new RecordingOsmAdapter(inner);
		const recorded = await rec.nearbyWays(51.55, -0.11, 50);

		const fixture = new FixtureOsmAdapter(rec.trace);
		const replayed = await fixture.nearbyWays(51.55, -0.11, 50);

		expect(replayed).toEqual(recorded);
	});

	it("rebuilds the Set<string> on linesAtPoint replay", async () => {
		const inner = mockOsmAdapter({ linesAtPoint: () => new Set(["Jubilee Line", "Carfaxloo Line"]) });
		const rec = new RecordingOsmAdapter(inner);
		await rec.linesAtPoint(51.51, -0.14, 100);

		const fixture = new FixtureOsmAdapter(rec.trace);
		const replayed = await fixture.linesAtPoint(51.51, -0.14, 100);

		expect(replayed).toBeInstanceOf(Set);
		expect([...replayed].sort()).toEqual(["Carfaxloo Line", "Jubilee Line"]);
	});

	it("replays a captured null reverseGeocode result (over open water, etc.)", async () => {
		const inner = mockOsmAdapter({ reverseGeocode: () => null });
		const rec = new RecordingOsmAdapter(inner);
		await rec.reverseGeocode(0, 0, 18);

		const fixture = new FixtureOsmAdapter(rec.trace);
		expect(await fixture.reverseGeocode(0, 0, 18)).toBeNull();
	});

	it("throws an actionable error when a query was not captured", async () => {
		const fixture = new FixtureOsmAdapter(emptyOsmTrace());
		await expect(fixture.nearbyWays(51.5, -0.1, 50)).rejects.toThrow(/uncaptured nearbyWays.*re-capture required/);
	});

	it("distinguishes null-captured from never-captured for reverseGeocode", async () => {
		// `nearbyWays` etc. return arrays — undefined-vs-empty-array is
		// trivially distinguishable. Nominatim returns null on legitimate
		// no-result, so the replay must distinguish "captured the null"
		// from "never asked".
		const inner = mockOsmAdapter({ reverseGeocode: () => null });
		const rec = new RecordingOsmAdapter(inner);
		await rec.reverseGeocode(0, 0, 18);

		const fixture = new FixtureOsmAdapter(rec.trace);
		expect(await fixture.reverseGeocode(0, 0, 18)).toBeNull();
		await expect(fixture.reverseGeocode(51.5, -0.1, 18)).rejects.toThrow(/uncaptured reverseGeocode/);
	});

	it("differentiates entries by radius", async () => {
		const inner = mockOsmAdapter({
			nearbyStations: (_lat, _lon, r) => [{ name: r === 200 ? "Near" : "Far", subtype: "rail", distanceM: r ?? 0 }],
		});
		const rec = new RecordingOsmAdapter(inner);
		await rec.nearbyStations(51.5, -0.1, 200);
		await rec.nearbyStations(51.5, -0.1, 400);

		const fixture = new FixtureOsmAdapter(rec.trace);
		expect((await fixture.nearbyStations(51.5, -0.1, 200))[0].name).toBe("Near");
		expect((await fixture.nearbyStations(51.5, -0.1, 400))[0].name).toBe("Far");
	});
});

describe("OsmTrace serialisation round-trip", () => {
	it("survives JSON.stringify/parse", async () => {
		const inner = mockOsmAdapter({
			nearbyWays: () => [{ type: "highway", subtype: "primary", name: "A1", distanceM: 7.5 }],
			linesAtPoint: () => new Set(["Northern Line"]),
			reverseGeocode: () => ({
				displayName: "Camden, London",
				type: "neighbourhood",
				category: "place",
				address: { city: "Greater London", neighbourhood: "Camden" },
			}),
		});
		const rec = new RecordingOsmAdapter(inner);
		await rec.nearbyWays(51.54, -0.14, 50);
		await rec.linesAtPoint(51.54, -0.14, 100);
		await rec.reverseGeocode(51.54, -0.14, 18);

		const serialised = JSON.stringify(rec.trace);
		const parsed = JSON.parse(serialised);
		const fixture = new FixtureOsmAdapter(parsed);

		expect((await fixture.nearbyWays(51.54, -0.14, 50))[0].name).toBe("A1");
		expect([...(await fixture.linesAtPoint(51.54, -0.14, 100))]).toEqual(["Northern Line"]);
		expect((await fixture.reverseGeocode(51.54, -0.14, 18))?.displayName).toBe("Camden, London");
	});
});
