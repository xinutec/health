import { describe, expect, it } from "vitest";
import { maxCorridorStall, renderWalkGrid, type WalkPanel } from "../src/eval/walk-render.js";

/**
 * The walk-match visual-diff harness (#293). `maxCorridorStall` is the triage
 * signal that sorts the worst-looking walks to the top of the grid; the
 * renderer must emit valid SVG for the panels.
 *
 * Coords run E along lon at lat 51.5 (~41.6 m per 0.0006° lon); the spur drops
 * ~111 m S in latitude.
 */
const at = (lat: number, lon: number) => ({ lat, lon });
const A = at(51.5, 0);
const B = at(51.5, 0.0006);
const C = at(51.5, 0.0012);

describe("maxCorridorStall (triage signal)", () => {
	it("is small for a clean match that follows the fixes", () => {
		expect(maxCorridorStall([A, B, C], [A, B, C])).toBeLessThan(10);
	});

	it("spikes for an out-and-back that makes no corridor progress", () => {
		// Path detours ~111 m south and back between B and C.
		expect(maxCorridorStall([A, B, C], [A, B, at(51.499, 0.0006), B, C])).toBeGreaterThan(150);
	});

	it("returns 0 when there is nothing to measure", () => {
		expect(maxCorridorStall([], [])).toBe(0);
	});
});

describe("renderWalkGrid", () => {
	it("emits a well-formed SVG containing a panel per walk", () => {
		const panels: WalkPanel[] = [
			{ label: "2026-06-30 13:20", raw: [A, B, C], matched: [A, B, C], smoothed: [A, C], stallM: 12 },
			{
				label: "2026-06-30 13:49",
				raw: [A, B, C],
				matched: [A, B, at(51.499, 0.0006), B, C],
				smoothed: [A, C],
				stallM: 180,
			},
		];
		const svg = renderWalkGrid(panels);
		expect(svg.startsWith("<svg")).toBe(true);
		expect(svg).toContain("2026-06-30 13:20");
		expect(svg).toContain("2026-06-30 13:49");
		// Worst stall sorts first.
		expect(svg.indexOf("13:49")).toBeLessThan(svg.indexOf("13:20"));
	});
});
