import { describe, expect, it } from "vitest";
import { despikeUnsupportedApexes } from "../src/geo/map-match-core.js";

/**
 * `despikeUnsupportedApexes` drops a matched vertex only when it (a) nearly
 * doubles back (a ~180° reversal, not a ~90° corner), (b) juts ≥15 m off the
 * chord, and (c) juts materially further than the raw GPS did there — i.e. the
 * snapper amplified a jitter into a triangle (#295). A real corner, or a spike
 * the raw fixes also make, survives.
 *
 * lat 51.5; 0.0001° lon ≈ 7 m, 0.0001° lat ≈ 11 m.
 */
const p = (lat: number, lon: number, ts: number) => ({ lat, lon, ts });
// Narrow spike: entry/exit ~14 m apart, apex ~33 m south → ~156° reversal.
const Ls = p(51.5, 0.0002, 0);
const Rs = p(51.5, 0.0004, 100);
const As = p(51.4997, 0.0003, 50);
// Wide corner: entry/exit ~42 m apart, same apex → ~116° turn (a real corner).
const Lc = p(51.5, 0, 0);
const Rc = p(51.5, 0.0006, 100);
const Ac = p(51.4997, 0.0003, 50);

describe("despikeUnsupportedApexes", () => {
	it("drops a reversal spike that overshoots the raw track", () => {
		const raw = [p(51.49991, 0.0003, 50)]; // GPS only ~10 m off
		expect(despikeUnsupportedApexes([Ls, As, Rs], raw)).toEqual([Ls, Rs]);
	});

	it("keeps a spike the raw GPS also makes (a real there-and-back)", () => {
		const raw = [p(51.4997, 0.0003, 50)]; // GPS went there too (~33 m)
		expect(despikeUnsupportedApexes([Ls, As, Rs], raw)).toEqual([Ls, As, Rs]);
	});

	it("keeps a real corner (a ~90° turn, not a reversal) even if the raw cut it", () => {
		const raw = [p(51.49991, 0.0003, 50)]; // GPS cut the corner, but it's a real turn
		expect(despikeUnsupportedApexes([Lc, Ac, Rc], raw)).toEqual([Lc, Ac, Rc]);
	});

	it("keeps the apex when no raw fix falls in the span", () => {
		expect(despikeUnsupportedApexes([Ls, As, Rs], [])).toEqual([Ls, As, Rs]);
	});

	it("keeps a gently-bowed vertex below the apex floor", () => {
		const path = [Ls, p(51.49995, 0.0003, 50), Rs]; // ~5.5 m off — not a spike
		expect(despikeUnsupportedApexes(path, [p(51.5, 0.0003, 50)])).toEqual(path);
	});
});
