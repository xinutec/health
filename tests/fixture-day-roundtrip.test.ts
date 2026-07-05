/**
 * Phase 6f of `docs/proposals/2026-06-deterministic-fixtures.md`: prove
 * the v2 fixture loop — serialise a `CapturedDay`, parse it back, rebuild
 * `ClassificationInputs` with a `FixtureOsmAdapter`, and run the pure core
 * — works end-to-end with no DB and no network, deterministically.
 *
 * The fixture here is an empty day: the closure the core needs is fully
 * present, and the run reaches no OSM call site (so the `FixtureOsmAdapter`
 * is wired but never queried). That isolates exactly the new plumbing the
 * v2 harness adds — envelope parse, version gate, inputs rebuild, core
 * execution off a deserialised closure. The OSM replay path itself is
 * covered by the Phase 6e adapter tests; an OSM-heavy day needs a real
 * `capture-day-v2` against prod and is migrated separately.
 */

import { describe, expect, it } from "vitest";
import {
	type CapturedDay,
	FIXTURE_FORMAT_VERSION,
	inputsFromFixture,
	parseCapturedDay,
} from "../src/cli/fixture-day.js";
import { normalizeStates } from "../src/cli/state-diff.js";
import { emptyOsmTrace } from "../src/geo/osm-adapter-recording.js";
import { computeVelocityFromInputs } from "../src/geo/velocity.js";

function emptyCapturedDay(): CapturedDay {
	return {
		meta: {
			fixtureFormatVersion: FIXTURE_FORMAT_VERSION,
			capturedAt: "2026-05-15T00:00:00.000Z",
			capturedAtCodeSha: "deadbeef",
			date: "2026-05-15",
			user: "pippijn",
			tz: "Europe/London",
			description: "empty-day round-trip",
		},
		inputs: {
			identity: { userId: "pippijn", date: "2026-05-15", displayTz: "Europe/London" },
			phonetrack: { today: [], morning: [], priorEvening: [] },
			knownPlaces: [],
			biometrics: { hr: [], sleep: [], steps: [] },
			modeBiometrics: [],
			hsmmDecode: null,
			railRouteCache: [],
			homeTz: "Europe/Amsterdam",
			sleepWindows: [],
			emptyDayBracket: null,
			osmTrace: emptyOsmTrace(),
		},
		expected: { velocity: [] },
	};
}

describe("CapturedDay round-trip + deterministic replay", () => {
	it("serialises to JSON, parses back, and replays with no DB", async () => {
		const json = JSON.stringify(emptyCapturedDay());
		const captured = parseCapturedDay(json);
		const result = await computeVelocityFromInputs(inputsFromFixture(captured));
		expect(normalizeStates(result.states, captured.meta.tz)).toEqual(captured.expected.velocity);
	});

	it("is deterministic: two replays of the same fixture agree", async () => {
		const json = JSON.stringify(emptyCapturedDay());
		const r1 = await computeVelocityFromInputs(inputsFromFixture(parseCapturedDay(json)));
		const r2 = await computeVelocityFromInputs(inputsFromFixture(parseCapturedDay(json)));
		expect(r1.states).toEqual(r2.states);
		expect(r1.segments).toEqual(r2.segments);
	});

	it("rejects a future fixture format version with an actionable error", () => {
		const bad = emptyCapturedDay();
		bad.meta.fixtureFormatVersion = 999;
		expect(() => parseCapturedDay(JSON.stringify(bad))).toThrow(/format version/);
	});
});
