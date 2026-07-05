/**
 * Pure presentation logic for the battery chart, extracted from the canvas
 * component so it can be unit-tested without a DOM/canvas. The component does
 * only the drawing; everything that can be *wrong* (the x-axis span, the
 * bottom time labels, which reading the "NN%" marker shows) lives here.
 */
import type { BatterySample } from "../../services/health.service";

export interface BatteryXRange {
	/** Timestamp (epoch seconds) of the first sample — the chart's left edge. */
	firstTs: number;
	/** Timestamp of the last sample — the right edge (the day-end anchor when
	 *  the series was extended across midnight). */
	lastTs: number;
	/** `lastTs - firstTs`, floored to 1 so a single-sample day never divides by
	 *  zero in the x-position mapping. */
	totalDuration: number;
}

/** The chart's horizontal span, or null when there is nothing to draw. */
export function batteryXRange(battery: readonly BatterySample[]): BatteryXRange | null {
	if (battery.length === 0) return null;
	const firstTs = battery[0].ts;
	const lastTs = battery[battery.length - 1].ts;
	return { firstTs, lastTs, totalDuration: lastTs - firstTs || 1 };
}

/**
 * The horizontal span covering ALL series (phone + watch), so both plot on a
 * shared time axis. Empty series are ignored; null when every series is empty.
 * Each series is assumed sorted ascending by `ts` (as the server emits them).
 */
export function batteryXRangeMulti(series: readonly (readonly BatterySample[])[]): BatteryXRange | null {
	let firstTs = Number.POSITIVE_INFINITY;
	let lastTs = Number.NEGATIVE_INFINITY;
	for (const s of series) {
		if (s.length === 0) continue;
		firstTs = Math.min(firstTs, s[0].ts);
		lastTs = Math.max(lastTs, s[s.length - 1].ts);
	}
	if (!Number.isFinite(firstTs)) return null;
	return { firstTs, lastTs, totalDuration: lastTs - firstTs || 1 };
}

/**
 * `count + 1` evenly-spaced HH:MM labels across `[firstTs, lastTs]`, rendered in
 * `tz`. Used for the timeline along the bottom of the chart. Rendering through
 * `Intl` with an explicit `timeZone` (rather than the host's local time) keeps
 * the labels correct and deterministically testable; `h23` forces midnight to
 * read `00:00`, not `24:00`.
 */
export function batteryTimeLabels(firstTs: number, lastTs: number, count: number, tz: string): string[] {
	const fmt = new Intl.DateTimeFormat("en-GB", {
		timeZone: tz,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	const total = lastTs - firstTs || 1;
	const labels: string[] = [];
	for (let i = 0; i <= count; i++) {
		const ts = firstTs + (total * i) / count;
		labels.push(fmt.format(new Date(ts * 1000)));
	}
	return labels;
}

/** The reading the end-of-line dot + "NN%" label marks: the last sample (the
 *  day-end value once the series is extended across midnight), or null. */
export function batteryMarker(battery: readonly BatterySample[]): BatterySample | null {
	return battery.length > 0 ? battery[battery.length - 1] : null;
}
