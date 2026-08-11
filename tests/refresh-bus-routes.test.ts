/**
 * The bus mirror rebuilds by DELETE + INSERT, so a bad run does not degrade the
 * cache — it replaces it. These pin when that replacement is refused (#255).
 *
 * The case worth stating: a run where most tiles fail returns a plausible
 * handful of routes, and the old guard (refuse only when EVERY tile failed)
 * waved it through. Nothing downstream would have said the mirror lost 90% of
 * its content — the bus matcher would simply stop naming routes it used to name.
 */

import { describe, expect, it } from "vitest";
import { rebuildRefusal } from "../src/geo/bus-route-cache.js";

describe("rebuildRefusal — when a rebuild must not replace the mirror", () => {
	it("allows a complete run whatever it found", () => {
		// No tile failed, so the result is authoritative even when it shrinks:
		// routes do leave OSM, and the home region can move.
		expect(rebuildRefusal(995, 995, 0)).toBeNull();
		expect(rebuildRefusal(995, 400, 0)).toBeNull();
		expect(rebuildRefusal(995, 0, 0)).toBeNull();
	});

	it("refuses the 90%-of-tiles-failed run that used to pass", () => {
		// The gap the old guard left: not empty, so it did not trip, and small
		// enough to gut the mirror.
		expect(rebuildRefusal(995, 80, 90)).toMatch(/995 -> 80/);
	});

	it("still refuses when every tile failed", () => {
		expect(rebuildRefusal(995, 0, 100)).toMatch(/Every tile failed/);
	});

	it("allows a partial run that kept the mirror substantially intact", () => {
		// A few tiles failing is normal and a slightly smaller mirror is not
		// evidence of damage — refusing here would make the job fail on noise.
		expect(rebuildRefusal(995, 900, 3)).toBeNull();
		expect(rebuildRefusal(995, 796, 3)).toBeNull(); // exactly at the floor
		expect(rebuildRefusal(995, 795, 3)).not.toBeNull(); // just under it
	});

	it("lets the FIRST run populate an empty cache", () => {
		// Nothing to protect, so a partial first mirror beats no mirror — and
		// this is the state the suspended job would start from.
		expect(rebuildRefusal(0, 40, 90)).toBeNull();
	});
});
