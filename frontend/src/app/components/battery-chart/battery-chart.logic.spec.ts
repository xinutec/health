import { describe, expect, it } from "vitest";
import { batteryMarker, batteryTimeLabels, batteryXRange, batteryXRangeMulti } from "./battery-chart.logic";

const sample = (ts: number, level: number) => ({ ts, level });

describe("batteryXRange", () => {
	it("returns null for an empty series (nothing to draw)", () => {
		expect(batteryXRange([])).toBeNull();
	});

	it("spans the first to the last sample", () => {
		expect(batteryXRange([sample(100, 90), sample(400, 60), sample(700, 30)])).toEqual({
			firstTs: 100,
			lastTs: 700,
			totalDuration: 600,
		});
	});

	it("floors a single-sample duration to 1 so the x-mapping never divides by zero", () => {
		expect(batteryXRange([sample(500, 42)])).toEqual({ firstTs: 500, lastTs: 500, totalDuration: 1 });
	});
});

describe("batteryXRangeMulti (phone + watch share one axis)", () => {
	it("returns null when every series is empty", () => {
		expect(batteryXRangeMulti([[], []])).toBeNull();
	});

	it("spans the earliest and latest sample across all series", () => {
		const phone = [sample(100, 90), sample(800, 40)];
		const watch = [sample(50, 80), sample(600, 55)];
		expect(batteryXRangeMulti([phone, watch])).toEqual({ firstTs: 50, lastTs: 800, totalDuration: 750 });
	});

	it("ignores an empty series and spans the non-empty one", () => {
		expect(batteryXRangeMulti([[], [sample(200, 70), sample(500, 30)]])).toEqual({
			firstTs: 200,
			lastTs: 500,
			totalDuration: 300,
		});
	});
});

describe("batteryTimeLabels (the bottom timeline)", () => {
	it("produces count+1 evenly-spaced labels across the range", () => {
		// 1970-01-01 00:00..06:00 UTC, 6 intervals → exactly one label per hour.
		expect(batteryTimeLabels(0, 6 * 3600, 6, "UTC")).toEqual([
			"00:00",
			"01:00",
			"02:00",
			"03:00",
			"04:00",
			"05:00",
			"06:00",
		]);
	});

	it("renders in the requested time zone (BST is UTC+1 in summer)", () => {
		const ts = Date.UTC(2026, 5, 26, 7, 19, 0) / 1000; // 07:19 UTC, 26 Jun
		expect(batteryTimeLabels(ts, ts, 6, "UTC")[0]).toBe("07:19");
		expect(batteryTimeLabels(ts, ts, 6, "Europe/London")[0]).toBe("08:19");
	});

	it("renders a midnight day-end anchor as 00:00, not 24:00", () => {
		// 00:00 BST on the 27th = 23:00 UTC on the 26th — the day-end anchor the
		// server interpolates the recovery line up to.
		const dayEnd = Date.UTC(2026, 5, 26, 23, 0, 0) / 1000;
		const labels = batteryTimeLabels(0, dayEnd, 6, "Europe/London");
		expect(labels.at(-1)).toBe("00:00");
	});

	it("matches the real 06-26 span: 08:19 on the left, midnight on the right", () => {
		const firstTs = Date.UTC(2026, 5, 26, 7, 19, 42) / 1000; // 08:19 BST
		const lastTs = Date.UTC(2026, 5, 26, 23, 0, 0) / 1000; // 00:00 BST (day end)
		const labels = batteryTimeLabels(firstTs, lastTs, 6, "Europe/London");
		expect(labels).toHaveLength(7);
		expect(labels[0]).toBe("08:19");
		expect(labels.at(-1)).toBe("00:00");
	});
});

describe("batteryMarker (the end-of-line NN% dot)", () => {
	it("returns null for an empty series", () => {
		expect(batteryMarker([])).toBeNull();
	});

	it("marks the last sample — the interpolated day-end value after the midnight extension", () => {
		// Discharge floor at 4%, then the midnight anchor the server interpolated
		// to 77%: the dot/label reflect the day-end value, not a mid-day reading.
		const series = [sample(0, 100), sample(1000, 4), sample(2000, 77)];
		expect(batteryMarker(series)).toEqual({ ts: 2000, level: 77 });
	});
});
