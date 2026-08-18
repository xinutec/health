/**
 * A no-data day still gets its bracketed stay (#1055).
 *
 * # Why this file exists rather than a golden day
 *
 * ⚠ NO FIXTURE CAN REACH THIS. 0 of the 42 golden days has zero fixes, so
 * `golden-check` and the day gate both pass whether the empty-day arm works or
 * not — which is exactly how the regression this guards got into production
 * unseen: `LEAN_DAY=solo` returns above the TS empty-day branch, and the bracket
 * was never put in the fold's request, so neither arm produced the stay.
 *
 * What is measured here is the WIRE: that `computeVelocityFromInputs` resolves
 * the bracket to a name and hands it to the fold. The DECISION — whether to emit
 * the state at all, and its shape — is `Verified.Geo.DayChain`'s, pinned by
 * `#guard` beside it, including the control that an observed day must not take
 * the arm.
 *
 * Synthetic throughout (#860): the coordinates are arbitrary and the place name
 * is invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassificationInputs, RawPhonetrackFix } from "../src/geo/classification-inputs.js";
import type { OsmAdapter } from "../src/geo/osm-adapter.js";
import type { DayRequestInputs } from "../src/lean/fold-capture.js";

vi.mock("../src/lean/lean-day.js", async (orig) => ({
	...(await orig<typeof import("../src/lean/lean-day.js")>()),
	soloLeanDay: vi.fn(),
}));

import { computeVelocityFromInputs } from "../src/geo/velocity.js";
import { soloLeanDay } from "../src/lean/lean-day.js";

const solo = vi.mocked(soloLeanDay);

const BRACKET = { centroidLat: 51.4, centroidLon: -0.2 };

/** Names any centroid, so the resolution the shell owes the fold can happen. */
function namingOsmAdapter(): OsmAdapter {
	return {
		nearbyWays: async () => [],
		nearbyStations: async () => [],
		nearbyLandmarks: async () => [{ name: "St Elsewhere", lat: 51.4, lon: -0.2, kind: "amenity" }],
		linesAtPoint: async () => new Set<string>(),
		reverseGeocode: async () => ({
			displayName: "St Elsewhere, Anytown",
			type: "hospital",
			category: "amenity",
			address: { amenity: "St Elsewhere", city: "Anytown" },
		}),
		nearbyTransitStops: async () => [],
		stationsOnLine: async () => [],
		drivableRoads: async () => [],
		walkableRoads: async () => [],
		buildingsNear: async () => [],
	} as unknown as OsmAdapter;
}

const DAY_START = Math.floor(Date.UTC(2026, 4, 14, 23, 0, 0) / 1000);

const fix = (offsetS: number): RawPhonetrackFix => ({
	ts: DAY_START + offsetS,
	lat: 51.4,
	lon: -0.2,
	altitude: null,
	speed: null,
	accuracy: 10,
	battery: 80,
});

/** A day with NOTHING observed — the shape the arm exists for. */
function emptyDay(bracket: ClassificationInputs["emptyDayBracket"]): ClassificationInputs {
	return {
		identity: { userId: "pippijn", date: "2026-05-15", displayTz: "Europe/London" },
		phonetrack: { today: [], morning: [], priorEvening: [] },
		knownPlaces: [],
		biometrics: { hr: [], sleep: [], steps: [] },
		modeBiometrics: [],
		hsmmDecode: null,
		railRouteCache: [],
		osm: namingOsmAdapter(),
		homeTz: "Europe/London",
		sleepWindows: [],
		emptyDayBracket: bracket,
	};
}

/** A day with a fix in it — the control for "observed days do not take the arm". */
function observedDay(bracket: ClassificationInputs["emptyDayBracket"]): ClassificationInputs {
	const day = emptyDay(bracket);
	return { ...day, phonetrack: { ...day.phonetrack, today: [fix(9 * 3600), fix(9 * 3600 + 120)] } };
}

async function requestFor(inputs: ClassificationInputs): Promise<DayRequestInputs> {
	await computeVelocityFromInputs(inputs);
	expect(solo).toHaveBeenCalledOnce();
	return solo.mock.calls[0][0] as DayRequestInputs;
}

beforeEach(() => {
	process.env.LEAN_DAY = "solo";
	solo.mockReset();
	solo.mockResolvedValue({ segs: [], states: [], episodes: [] });
});

describe("the empty-day bracket reaches the fold", () => {
	it("sends the resolved place name for a bracketed no-data day", async () => {
		const req = await requestFor(emptyDay(BRACKET));
		expect(req.tail?.bracketPlace).toBeDefined();
		expect(typeof req.tail?.bracketPlace).toBe("string");
	});

	// The span the inferred stay covers. Without a start the fold would have to
	// invent one, and a day is not always 86400s — a DST day is not.
	it("sends the day's start as well as its end", async () => {
		const req = await requestFor(emptyDay(BRACKET));
		expect(req.tail?.dayStartTs).toBeGreaterThan(0);
		expect(req.tail?.dayEndTs).toBeGreaterThan(req.tail?.dayStartTs ?? 0);
		expect(req.tail?.dayTz).toBe("Europe/London");
	});

	// ⚠ An unbracketed day is honestly UNKNOWN. Sending a name here would let the
	// fold assert a stay nothing constrains, which is worse than a blank day.
	it("sends nothing when the day is not bracketed on both sides", async () => {
		const req = await requestFor(emptyDay(null));
		expect(req.tail?.bracketPlace).toBeUndefined();
	});

	// ⚠ THE CONTROL, and the reason the resolution is gated rather than
	// unconditional: an observed day must not pay for a lookup it cannot use.
	// The fold applies its own emptiness test too, so this is cost, not
	// correctness — but a green test here with the gate removed would hide that
	// every day had started making an extra mirror call.
	it("does not resolve a bracket for a day that has observations", async () => {
		const req = await requestFor(observedDay(BRACKET));
		expect(req.tail?.bracketPlace).toBeUndefined();
	});
});
