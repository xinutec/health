#!/usr/bin/env -S npx tsx
/**
 * Derive `#guard` expectations for `Verified.ApiWindow` from V8.
 *
 * Two rules sit in front of every multi-day API read, and one of them is a
 * security boundary rather than a convenience:
 *
 *   - `daysParam` coerces, clamps to [1, 365] and defaults to 30. A request
 *     asking for 100000 days must not become a full-history dump;
 *   - `sinceDateForSession` takes the LATER of `today - days` and the share
 *     window's `from`, so a share recipient's multi-day read is capped by their
 *     window NO MATTER how large `days` is. Getting the comparison backwards
 *     hands a recipient the owner's whole history, and the response looks
 *     entirely normal.
 *
 * ⚠ `sinceDate` counts back from UTC today, via `Date.setDate`, which is what
 * makes the month and year rollovers worth pinning rather than reasoning about.
 * A fixed `today` is passed in below so the expectations do not move with the
 * clock; the production function reads `new Date()`.
 *
 * Run: npx tsx lean/experiments/apiwindow-refs.mts
 */
import { sinceDateForSession } from "../../src/routes/api.js";

/** `sinceDate`, with `today` injected — the production one reads the clock. */
function sinceDateAt(todayIso: string, days: number): string {
	const d = new Date(`${todayIso}T00:00:00.000Z`);
	d.setDate(d.getDate() - days);
	return d.toISOString().slice(0, 10);
}

console.log("--- sinceDate(today, days) ---");
for (const [today, days] of [
	["2026-08-22", 1],
	["2026-08-22", 30],
	["2026-08-22", 365],
	// Month rollover, year rollover, and across a leap day.
	["2026-03-01", 1],
	["2026-01-01", 1],
	["2026-03-01", 60],
	["2024-03-01", 1],
	["2024-03-01", 2],
] as const) {
	console.log(`sinceDate(${today}, ${days}): ${JSON.stringify(sinceDateAt(today, days))}`);
}

console.log("--- sinceDateForSession: the share window CAPS the read ---");
const owner = {};
const viewer = { shareViewer: { from: "2026-08-11", to: "2026-08-17" } };
// The production function reads the clock, so these are relative to today. What
// matters is the COMPARISON, so both arms are printed for the same input.
for (const days of [1, 7, 30, 365]) {
	const o = sinceDateForSession(owner, days);
	const v = sinceDateForSession(viewer, days);
	console.log(`days=${days}: owner=${o} viewer=${v} viewerIsLater=${v >= o}`);
}

// ⚠ `daysParam` is `z.coerce.number().int().min(1).max(365).default(30)`, and
// zod's `.min`/`.max` VALIDATE rather than clamp — so an out-of-range `days` is
// a rejection, not a silently narrowed window. Encoding it as a clamp would
// answer a bad request with a plausible day range instead of an error.
console.log("--- daysParam: what does it do with each input? ---");
{
	const { z } = await import("zod");
	const daysParam = z.coerce.number().int().min(1).max(365).default(30);
	for (const raw of [undefined, "7", "1", "365", "0", "-1", "366", "7.5", "abc", ""] as const) {
		let out: string;
		try {
			out = JSON.stringify(daysParam.parse(raw));
		} catch (e) {
			out = `THROWS (${(e as { issues?: { code: string }[] }).issues?.[0]?.code ?? "error"})`;
		}
		console.log(`daysParam.parse(${JSON.stringify(raw)}): ${out}`);
	}
}
