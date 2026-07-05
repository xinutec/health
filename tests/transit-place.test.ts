import { describe, expect, it } from "vitest";
import type { NearbyStation } from "../src/geo/osm.js";
import {
	STATION_AT_ALIGHT_RADIUS_M,
	stationAtTrainAlight,
	stationAtTransitInterchange,
} from "../src/geo/transit-place.js";
import { mockOsmAdapter } from "./helpers/mock-osm-adapter.js";

const station = (name: string, distanceM: number): NearbyStation => ({ name, subtype: "subway", distanceM });
const LAT = 51.547;
const LON = -0.18;

describe("stationAtTrainAlight", () => {
	it("names the station when a train-alighting stay sits within range", async () => {
		const osm = mockOsmAdapter({ nearbyStations: () => [station("Brookden", 40)] });
		expect(await stationAtTrainAlight({ mode: "train" }, LAT, LON, osm)).toBe("Brookden");
	});

	it("honours refinedMode when the base mode differs", async () => {
		const osm = mockOsmAdapter({ nearbyStations: () => [station("Brookden", 40)] });
		expect(await stationAtTrainAlight({ mode: "driving", refinedMode: "train" }, LAT, LON, osm)).toBe("Brookden");
	});

	it("returns the nearest of several stations", async () => {
		const osm = mockOsmAdapter({ nearbyStations: () => [station("Far", 120), station("Near", 30)] });
		expect(await stationAtTrainAlight({ mode: "train" }, LAT, LON, osm)).toBe("Near");
	});

	it("does not fire when the preceding segment is not a train", async () => {
		const osm = mockOsmAdapter({ nearbyStations: () => [station("Brookden", 40)] });
		expect(await stationAtTrainAlight({ mode: "walking" }, LAT, LON, osm)).toBeNull();
	});

	it("does not fire with no preceding segment (first stay of the day)", async () => {
		const osm = mockOsmAdapter({ nearbyStations: () => [station("Brookden", 40)] });
		expect(await stationAtTrainAlight(undefined, LAT, LON, osm)).toBeNull();
	});

	it("returns null when the nearest station is beyond the footprint", async () => {
		const osm = mockOsmAdapter({ nearbyStations: () => [station("Brookden", 400)] });
		expect(await stationAtTrainAlight({ mode: "train" }, LAT, LON, osm, STATION_AT_ALIGHT_RADIUS_M)).toBeNull();
	});

	it("returns null when no station is nearby (train ended mid-network gap)", async () => {
		const osm = mockOsmAdapter({ nearbyStations: () => [] });
		expect(await stationAtTrainAlight({ mode: "train" }, LAT, LON, osm)).toBeNull();
	});
});

describe("stationAtTransitInterchange", () => {
	// A segment at minute `m` lasting `durMin`; modes & timing only.
	const seg = (mode: string, startMin: number, durMin: number, refinedMode?: string) =>
		({
			mode,
			refinedMode,
			startTs: startMin * 60,
			endTs: (startMin + durMin) * 60,
		}) as never;
	const bakerOsm = mockOsmAdapter({ nearbyStations: () => [station("Carfax", 40)] });

	it("names the station for a train → short walk → STAY → train interchange (the 06-29 Carfax case)", async () => {
		const segs = [
			seg("train", 0, 2), // Deepwell Sq → Carfax
			seg("walking", 2, 3), // platform-to-platform change
			seg("stationary", 5, 5), // the wait — i=2
			seg("train", 10, 10), // Carfax → Ashvale
		];
		expect(await stationAtTransitInterchange(segs, 2, LAT, LON, bakerOsm)).toBe("Carfax");
	});

	it("names the station for a direct train → STAY → train interchange (no walk)", async () => {
		const segs = [seg("train", 0, 2), seg("stationary", 2, 4), seg("train", 6, 8)];
		expect(await stationAtTransitInterchange(segs, 1, LAT, LON, bakerOsm)).toBe("Carfax");
	});

	it("honours refinedMode on the bracketing legs", async () => {
		const segs = [seg("driving", 0, 2, "train"), seg("stationary", 2, 4), seg("driving", 6, 8, "train")];
		expect(await stationAtTransitInterchange(segs, 1, LAT, LON, bakerOsm)).toBe("Carfax");
	});

	it("does NOT fire for a long stay between an outbound and a return train (a destination, not a change)", async () => {
		// The 2026-06-24 UCLH appointment: a 2-hour stay near Gorse End,
		// bracketed by a Ashvale↔Deepwell round trip. Trains on both sides, but
		// it's a destination, not an interchange.
		const segs = [
			seg("train", 0, 22), // Ashvale → Deepwell
			seg("walking", 22, 5),
			seg("stationary", 27, 119), // ~2-hour appointment — i=2
			seg("walking", 146, 5),
			seg("train", 151, 13), // Deepwell → Ashvale
		];
		expect(await stationAtTransitInterchange(segs, 2, LAT, LON, bakerOsm)).toBeNull();
	});

	it("does NOT fire when only one side is a train (a genuine destination at a station)", async () => {
		const segs = [seg("train", 0, 2), seg("stationary", 2, 30), seg("walking", 32, 10)];
		expect(await stationAtTransitInterchange(segs, 1, LAT, LON, bakerOsm)).toBeNull();
	});

	it("names the station across a long large-station transfer walk (Elmford Victoria→Met, ~10 min)", async () => {
		// The 2026-06-16 phantom "Megaro Hotel": a short station-sited wait during
		// a change between separate stations of the Elmford complex, reached
		// across a genuine ~10-min concourse walk.
		const segs = [
			seg("train", 0, 11), // Victoria → Elmford (Victoria Line)
			seg("walking", 11, 2),
			seg("stationary", 13, 5), // the wait — i=2
			seg("walking", 18, 10), // ~10-min concourse transfer to the Met platforms
			seg("train", 28, 4), // Elmford → Ashvale (Met Line)
		];
		expect(await stationAtTransitInterchange(segs, 2, LAT, LON, bakerOsm)).toBe("Carfax");
	});

	it("does NOT fire across a genuinely long walk with a short stay — a real walk to a venue", async () => {
		// Short stay (so the dwell guard doesn't decide it) but a 15-min walk — you
		// went somewhere, this is not a platform-to-platform transfer.
		const segs = [
			seg("train", 0, 2),
			seg("walking", 2, 15), // 15-min walk: beyond any concourse transfer
			seg("stationary", 17, 5),
			seg("train", 22, 8),
		];
		expect(await stationAtTransitInterchange(segs, 2, LAT, LON, bakerOsm)).toBeNull();
	});

	it("does NOT fire when no station is within the footprint", async () => {
		const farOsm = mockOsmAdapter({ nearbyStations: () => [station("Carfax", 400)] });
		const segs = [seg("train", 0, 2), seg("stationary", 2, 4), seg("train", 6, 8)];
		expect(await stationAtTransitInterchange(segs, 1, LAT, LON, farOsm)).toBeNull();
	});

	it("does NOT fire for a plain stay with no surrounding trains", async () => {
		const segs = [seg("walking", 0, 5), seg("stationary", 5, 40), seg("walking", 45, 5)];
		expect(await stationAtTransitInterchange(segs, 1, LAT, LON, bakerOsm)).toBeNull();
	});

	// --- established-focus-place guard (2026-07-02 UCLH → "Gorse End") --
	// A stay the place prior confidently assigned to an established focus
	// place is a genuine destination even when a ride brackets each side:
	// the RT visit sat 5 m from a 6-day hospital focus place, between the
	// morning tube and a one-stop hop onward, and got renamed after the
	// station 100 m away. Trains on both sides prove a JOURNEY structure,
	// not that the stop between them was a platform.
	it("does NOT rename a stay assigned to an established focus place", async () => {
		const segs = [
			seg("train", 0, 25),
			seg("walking", 25, 10),
			seg("stationary", 35, 10), // the hospital visit — i=2
			seg("walking", 45, 6),
			seg("train", 51, 2), // one-stop hop onward
		];
		expect(await stationAtTransitInterchange(segs, 2, LAT, LON, bakerOsm, undefined, 6)).toBeNull();
	});

	it("still renames when the stay's focus place is too new to trust", async () => {
		const segs = [seg("train", 0, 2), seg("stationary", 2, 4), seg("train", 6, 8)];
		expect(await stationAtTransitInterchange(segs, 1, LAT, LON, bakerOsm, undefined, 1)).toBe("Carfax");
	});

	it("still renames when the stay has no focus-place provenance", async () => {
		const segs = [seg("train", 0, 2), seg("stationary", 2, 4), seg("train", 6, 8)];
		expect(await stationAtTransitInterchange(segs, 1, LAT, LON, bakerOsm, undefined, undefined)).toBe("Carfax");
	});
});
