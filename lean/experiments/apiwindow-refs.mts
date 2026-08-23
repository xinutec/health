#!/usr/bin/env -S npx tsx
/**
 * Derive `#guard` expectations for `Verified.ApiWindow` from V8.
 *
 * Two rules sit in front of every multi-day API read, and one of them is a
 * security boundary rather than a convenience:
 *
 *   - `daysParam` coerces, REJECTS outside [1, 365] and defaults to 30. A
 *     request asking for 100000 days is an error, not a full-history dump and
 *     not a quietly narrowed window;
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
// ⚠ The share window is derived FROM TODAY so the printed relations are stable
// forever. A fixed date like "2026-08-11" is not enough: `today - 30` creeps
// forward and would cross it, flipping `cappedAtShareStart` weeks later — the
// same clock dependency one layer down, just slower to bite.
const shareFrom = sinceDateAt(new Date().toISOString().slice(0, 10), 10);
const viewer = { shareViewer: { from: shareFrom, to: shareFrom } };
// ⚠ NO ABSOLUTE DATES PRINTED HERE. The production function reads `new Date()`,
// so printing what it returned pinned this snapshot to the day it was blessed —
// and the gate went red at the next midnight, for no reason anyone had changed.
// Found 2026-08-23, one day after this file was written.
//
// What the rule actually claims is a RELATION, and a relation is clock-free:
// the viewer's floor is never earlier than the owner's, and once `days` reaches
// back past the share's start it is exactly that start. Both hold on any day.
for (const days of [1, 7, 30, 365]) {
	const o = sinceDateForSession(owner, days);
	const v = sinceDateForSession(viewer, days);
	const capped = v === shareFrom;
	console.log(`days=${days}: viewerIsNotEarlier=${v >= o} cappedAtShareStart=${capped}`);
}

// ⚠ `daysParam` is `z.coerce.number().int().min(1).max(365).default(30)`, and
// zod's `.min`/`.max` VALIDATE rather than clamp — so an out-of-range `days` is
// a rejection, not a silently narrowed window. Encoding it as a clamp would
// answer a bad request with a plausible day range instead of an error.
console.log("--- daysParam: what does it do with each input? ---");
{
	const { z } = await import("zod");
	const daysParam = z.coerce.number().int().min(1).max(365).default(30);
	// ⚠ The last five are the ones a host's own parser gets wrong. `Number` trims
	// whitespace, maps "" to 0 (not NaN), reads HEX, and accepts an exponent and
	// a trailing ".0" as integers — so `0x10` is a valid 16-day window.
	for (const raw of [
		undefined, "7", "1", "365", "0", "-1", "366", "7.5", "abc", "",
		" 7 ", "0x10", "1e2", "7.0", "Infinity",
	] as const) {
		let out: string;
		try {
			out = JSON.stringify(daysParam.parse(raw));
		} catch (e) {
			out = `THROWS (${(e as { issues?: { code: string }[] }).issues?.[0]?.code ?? "error"})`;
		}
		console.log(`daysParam.parse(${JSON.stringify(raw)}): ${out}`);
	}
}
