/**
 * Reference values for `src/share/token.ts` → `Verified/Share.lean`.
 *
 * Imports the PRODUCTION TypeScript, so these are the numbers the running
 * system produces, not the numbers the port's author believed it produced.
 * `refs-snapshot.mts` holds this output to a committed snapshot, so the TS
 * moving under the Lean guards is a red gate rather than a silent drift (#1003).
 *
 * `generateShareToken` is deliberately absent: it reads the CSPRNG, so it has no
 * reference value and no Lean twin. It stays in Rust with the rest of the IO.
 *
 * Cases are chosen to be the ones a wrong port passes anyway if you only test
 * the happy path — the February boundaries, the year boundary, the clamp edges,
 * and the malformed date that TypeScript turns into "NaN-NaN-NaN" rather than
 * refusing.
 *
 * Run: pnpm exec tsx lean/experiments/share-refs.mts
 */
import { buildShareUrl, clampShareDaysBack, shareableDateRange, SHARE_DAYS_MAX, SHARE_DAYS_MIN } from "../../src/share/token.js";

console.log("=== buildShareUrl ===");
for (const [base, token] of [
	["https://h.example", "abc"],
	["https://h.example/", "abc"],
	["https://h.example//", "abc"],
	["https://h.example/sub", "tok-123"],
] as const) {
	console.log(`buildShareUrl(${JSON.stringify(base)}, ${JSON.stringify(token)}):`, JSON.stringify(buildShareUrl(base, token)));
}

console.log("\n=== shareableDateRange ===");
for (const [today, days] of [
	["2026-08-17", 1],
	["2026-08-17", 7],
	["2026-08-17", 0],
	["2026-08-17", -3],
	// Month boundary, and the same boundary in a leap year.
	["2026-03-02", 3],
	["2024-03-02", 3],
	// Year boundary.
	["2027-01-02", 4],
	// Century and 400-year leap rules — 1900 is not a leap year, 2000 is.
	["1900-03-01", 2],
	["2000-03-01", 2],
	// The full window.
	["2026-08-17", 365],
] as const) {
	console.log(`shareableDateRange(${JSON.stringify(today)}, ${days}):`, JSON.stringify(shareableDateRange(today, days)));
}

// ⚠ THE DIVERGENCE THIS FILE EXISTS TO RECORD. The TypeScript does not parse
// its input: `"not-a-date".split("-").map(Number)` yields NaN, `Date.UTC(NaN…)`
// yields an Invalid Date, and the formatter prints it. The Lean port returns
// `none` instead. That is a DELIBERATE behaviour change, not a port defect, and
// it must be visible here rather than discovered when the snapshot moves.
console.log("\n=== shareableDateRange: inputs the TS does not reject ===");
for (const [today, days] of [
	["not-a-date", 7],
	["2026-02-30", 7],
	["2026-2-03", 7],
] as const) {
	console.log(`shareableDateRange(${JSON.stringify(today)}, ${days}):`, JSON.stringify(shareableDateRange(today, days)));
}

console.log("\n=== clampShareDaysBack ===");
for (const v of [30, 0, -5, 100000, 365, 1, 0.5, 7.9, Number.NaN, Number.POSITIVE_INFINITY, "30", null, undefined]) {
	console.log(`clampShareDaysBack(${JSON.stringify(v) ?? "undefined"}):`, JSON.stringify(clampShareDaysBack(v)));
}

console.log("\n=== bounds ===");
console.log("SHARE_DAYS_MIN:", SHARE_DAYS_MIN);
console.log("SHARE_DAYS_MAX:", SHARE_DAYS_MAX);
