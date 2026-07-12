import { describe, expect, it } from "vitest";
import { confirmedLabelFor, type PlaceConfirmation } from "../src/geo/place-confirmation.js";

// The real coordinates. Urban Social Coffee sits at 51.544742,-0.103575; the
// stay centroid smears ~16 m west of it, to 51.544782,-0.103801.
const URBAN_SOCIAL: PlaceConfirmation = {
	lat: 51.544742,
	lon: -0.103575,
	radiusM: 40,
	label: "Urban Social",
};

describe("confirmedLabelFor", () => {
	// The whole point. The fixes are smeared 16 m off the venue and no amount of
	// geometry separates it from the pub sharing its building — but the user has
	// said which it is, once, and that settles it for every future visit.
	it("labels a stay smeared 16 m off the venue the user confirmed", () => {
		expect(confirmedLabelFor(51.544782, -0.103801, [URBAN_SOCIAL])).toBe("Urban Social");
	});

	it("does not reach beyond its radius", () => {
		// ~90 m north — a different venue up the street, not this one.
		expect(confirmedLabelFor(51.545551, -0.103575, [URBAN_SOCIAL])).toBeNull();
	});

	it("returns null when nothing is confirmed", () => {
		expect(confirmedLabelFor(51.544782, -0.103801, [])).toBeNull();
	});

	// Overlapping radii — the user has named two neighbouring places, and a stay
	// falls inside both. The nearer confirmation is the better claim.
	it("prefers the nearest confirmation when radii overlap", () => {
		const nextDoor: PlaceConfirmation = { lat: 51.5449, lon: -0.1036, radiusM: 60, label: "Benita Bakery" };
		expect(confirmedLabelFor(51.544782, -0.103801, [nextDoor, URBAN_SOCIAL])).toBe("Urban Social");
	});
});
