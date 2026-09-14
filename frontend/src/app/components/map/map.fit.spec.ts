import { describe, expect, it } from "vitest";
import { canFitBounds, FIT_PADDING_PX } from "./map.fit";

describe("map fit guard (#1616)", () => {
	it("fits a normally laid-out container", () => {
		expect(canFitBounds({ x: 411, y: 420 })).toBe(true);
	});

	it("refuses a container that has not been laid out", () => {
		// ⚠ THE CASE THAT HUNG THE RENDERER. An element inside a hidden mat-tab
		// reports 0x0, `fitBounds` subtracts 48, and the negative size becomes a
		// NaN zoom that Leaflet's own clamp and `Infinity` guard both pass
		// through.
		expect(canFitBounds({ x: 0, y: 0 })).toBe(false);
	});

	it("refuses anything at or under the padding it will subtract", () => {
		// ⚠ NOT ONLY 0x0 — the whole band up to 2*padding is unusable, which is
		// exactly what a mat-tab transition or a short split-screen viewport
		// passes through on its way to a real size.
		const consumed = FIT_PADDING_PX * 2;
		expect(canFitBounds({ x: consumed - 1, y: 500 })).toBe(false);
		expect(canFitBounds({ x: 500, y: consumed - 1 })).toBe(false);
		// At exactly 2*padding the size is 0: scale 0, log2(0) = -Infinity.
		// Not NaN, still not a zoom.
		expect(canFitBounds({ x: consumed, y: consumed })).toBe(false);
		expect(canFitBounds({ x: consumed + 1, y: consumed + 1 })).toBe(true);
	});

	it("fails on EITHER axis, because Math.min takes the worse one", () => {
		expect(canFitBounds({ x: 1000, y: 0 })).toBe(false);
		expect(canFitBounds({ x: 0, y: 1000 })).toBe(false);
	});
});
