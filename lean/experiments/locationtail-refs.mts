#!/usr/bin/env -S npx tsx
/**
 * Derive `#guard` expectations for `Verified.LocationTail` from V8.
 *
 * `/location/tail` answers "every fix after the one you already have". Its rule
 * is one line in `src/routes/api.ts`:
 *
 *     points.filter(p => p.ts > since).slice(-TAIL_MAX_POINTS)
 *
 * and both halves invert without looking wrong. `>` is strict, so the point the
 * caller named is not resent; `slice(-n)` takes the LAST n, so a long tail
 * answers with the newest points rather than the oldest. Getting the second
 * backwards would answer a live map with the stale head of the buffer and never
 * reach the present — a failure that looks like lag, not like a bug.
 *
 * ⚠ The two cache TTLs are written with opposite comparisons in the TypeScript
 * (`now - at < TTL` for the fix, `now - at >= TTL` inverted for the tail). They
 * are the same boundary said twice, and that is worth showing rather than
 * asserting.
 *
 * Run: npx tsx lean/experiments/locationtail-refs.mts
 */
const TAIL_MAX_POINTS = 2000;
const LATEST_FIX_TTL_MS = 10_000;
const TAIL_TTL_MS = 10_000;

/** Exactly the production expression, over bare timestamps. */
function tailAfter(tss: number[], since: number): number[] {
	return tss.filter((t) => t > since).slice(-TAIL_MAX_POINTS);
}

console.log("--- tailAfter(tss, since): the filter is STRICT ---");
for (const [tss, since] of [
	[[1, 2, 3], 2],
	[[1, 2, 3], 0],
	[[1, 2, 3], 3],
	[[], 0],
] as const) {
	console.log(`tailAfter(${JSON.stringify(tss)}, ${since}): ${JSON.stringify(tailAfter([...tss], since))}`);
}

console.log("--- the cap keeps the NEWEST, not the oldest ---");
{
	const many = Array.from({ length: 3000 }, (_, i) => i + 1);
	const out = tailAfter(many, 0);
	console.log(`3000 points, since=0: length=${out.length} first=${out[0]} last=${out.at(-1)}`);
	const few = Array.from({ length: 10 }, (_, i) => i + 1);
	console.log(`10 points, since=4: length=${tailAfter(few, 4).length}`);
}

console.log("--- cache freshness: both TTLs, at the boundary ---");
// The fix cache is `now - at < TTL`; the tail cache refetches on `>= TTL`.
const fixFresh = (at: number, now: number) => now - at < LATEST_FIX_TTL_MS;
const tailFresh = (at: number, now: number) => !(now - at >= TAIL_TTL_MS);
for (const [at, now] of [
	[1000, 1000],
	[1000, 10_999],
	[1000, 11_000],
	[1000, 20_000],
] as const) {
	console.log(`at=${at} now=${now}: fix=${fixFresh(at, now)} tail=${tailFresh(at, now)} agree=${fixFresh(at, now) === tailFresh(at, now)}`);
}
