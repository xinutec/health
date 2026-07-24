/**
 * V8 reference values for the Lean port of `src/geo/opening-hours.ts`.
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/opening-hours-refs.mts
 *
 * The parser is regex-driven, and its exact behaviour on MALFORMED input is
 * load-bearing: a wrong "closed" verdict poisons the venue scorer, so
 * everything outside the supported subset must parse to null. Several of the
 * cases below are deliberately degenerate (a bare "off", a two-letter prefix
 * that looks like a day) because the regex's treatment of them is subtle and
 * the Lean hand-rolled parser has to reproduce it, quirks included.
 */

import { parseOpeningHours, isOpenAt, type WeekSpec } from "../../src/geo/opening-hours.js";

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function show(value: string): void {
	const spec = parseOpeningHours(value);
	if (spec === null) {
		console.log(`${JSON.stringify(value)} => null`);
		return;
	}
	const body = spec
		.map((day, i) => `${DAYS[i]}:[${day.map((r) => `${r.startMin}-${r.endMin}`).join(" ")}]`)
		.join(" ");
	console.log(`${JSON.stringify(value)} => ${body}`);
}

console.log("=== parseOpeningHours ===");
// The common real shapes.
show("24/7");
show("Mo-Fr 09:00-17:00");
show("Mo-Fr 09:00-17:00; Sa 10:00-16:00");
show("Mo-Sa 08:00-18:00; We off");
show("Mo,We-Fr 08:00-12:00");
show("Sa-Mo 10:00-14:00"); // wrapping day range
show("08:00-20:00"); // no day spec = every day
show("Mo-Su 11:00-23:00");
show("Mo-Fr 08:00-12:00,13:00-17:00"); // split day
show("Tu-Su 20:00-02:00"); // wraps past midnight
show("Mo-Fr 09:00-17:00; PH off"); // trailing PH
show("PH off");
show("Mo-Fr 9:00-17:00"); // 1-digit hour
show("Mo-Fr 09:00-17:00; Sa closed");
show("mo-fr 09:00-17:00"); // lowercase days
show("Mo-Fr  09:00-17:00"); // extra whitespace
show("Mo - Fr 09:00-17:00"); // spaced day range
show("Mo,Tu,We 09:00-17:00");
show("Su 12:00-16:00; Mo-Sa 09:00-20:00"); // later rule wins for its days

console.log("");
console.log("=== outside the subset => null (no evidence, NOT closed) ===");
show("");
show("   ");
show("sunrise-sunset");
show("Mo-Fr 09:00+");
show("Jan-Mar 09:00-17:00");
show("week 1-10 09:00-17:00");
show("Mo-Fr 09:00-17:00; Xx 10:00-12:00");
show("Mo-Fr 25:00-27:00"); // past 24:00
show("Mo-Fr 09:0-17:00"); // malformed minutes
show("Mo-Fr 0900-1700");
show("off"); // NOTE: "of" parses as a day token, then fails
show("closed");
show("Mo-Fr");
show("Mo-Fr off; Sa 10:00-12:00");
show("Mo-Zz 09:00-17:00");
show("24/7 open");

console.log("");
console.log("=== isOpenAt ===");
function probe(value: string, cases: [number, number][]): void {
	const spec = parseOpeningHours(value);
	if (spec === null) {
		console.log(`${JSON.stringify(value)} => null spec`);
		return;
	}
	const out = cases.map(([d, m]) => `${DAYS[d]}@${m}=${isOpenAt(spec as WeekSpec, d, m)}`).join(" ");
	console.log(`${JSON.stringify(value)}: ${out}`);
}
probe("Mo-Fr 09:00-17:00", [
	[0, 540], // exactly open
	[0, 539], // one minute early
	[0, 1019], // last open minute
	[0, 1020], // exactly close (exclusive)
	[5, 600], // Saturday
]);
probe("Tu-Su 20:00-02:00", [
	[1, 1200], // Tue 20:00 open
	[1, 60], // Tue 01:00 — from MONDAY's overflow? Mo not in spec
	[2, 60], // Wed 01:00 — Tue's overflow
	[2, 120], // Wed 02:00 — overflow ended
	[0, 60], // Mon 01:00 — Sun's overflow
	[1, 1199], // Tue 19:59
]);
probe("24/7", [
	[0, 0],
	[3, 720],
	[6, 1439],
]);
probe("Mo-Sa 08:00-18:00; We off", [
	[2, 720], // Wednesday closed
	[1, 720], // Tuesday open
]);
probe("Mo-Fr 08:00-12:00,13:00-17:00", [
	[0, 700], // in first range
	[0, 750], // the lunch gap
	[0, 800], // in second range
]);
