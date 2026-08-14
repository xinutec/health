#!/usr/bin/env node
// Every WALKING segment in the golden corpus: the maxSpeed it REPORTS against
// the maxSpeed its OWN fixes support.
//
// The detector behind #810 was "a walking segment whose maxSpeed is
// vehicle-paced has swallowed part of a ride". That test can only work if
// `maxSpeed` was measured over the segment it describes. Several carves split a
// host segment and hand the pieces `{...host}`, so the piece reports the
// PARENT's kinematics — measured across the ride the carve just removed.
//
// So this prints both arms. `own` is recomputed from the fixes inside the
// segment's own window, the way `walkRemainder` (stay-split.ts) already does
// for the vehicle-split carve.
//
// Usage: nix develop . --command node scripts/probe-walk-maxspeed.mjs [minKmh]
import { readdirSync, readFileSync } from "node:fs";
import { inputsFromFixture, parseCapturedDay } from "../dist/cli/fixture-day.js";
import { computeVelocityFromInputs } from "../dist/geo/velocity.js";

const minKmh = Number(process.argv[2] ?? 0);

const hm = (ts) => new Date(ts * 1000).toISOString().slice(11, 16);
const mode = (s) => s.refinedMode ?? s.mode;
const r1 = (x) => Math.round(x * 10) / 10;

const days = readdirSync("tests/golden/days")
	.filter((f) => f.endsWith(".json"))
	.sort();

const walks = [];
for (const file of days) {
	const date = file.slice(0, 10);
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${file}`, "utf8"));
	const inputs = inputsFromFixture(captured);
	const { segments, points } = await computeVelocityFromInputs(inputs, { walkMatch: false });
	for (const [i, s] of segments.entries()) {
		if (mode(s) !== "walking") continue;
		const own = (points ?? []).filter((p) => p.ts >= s.startTs && p.ts <= s.endTs);
		const speeds = own.map((p) => p.speed_kmh ?? 0);
		walks.push({
			date,
			seg: s,
			prev: segments[i - 1],
			next: segments[i + 1],
			ownMax: speeds.length ? r1(Math.max(...speeds)) : null,
			ownPts: own.length,
		});
	}
}

console.log(`\n${walks.length} walking segments across ${days.length} days\n`);

const dist = (label, vals) => {
	const s = [...vals].sort((a, b) => a - b);
	const pct = (p) => s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))];
	console.log(`${label}: ` + [50, 75, 90, 95, 99, 100].map((p) => `p${p}=${r1(pct(p))}`).join("  "));
};
dist("maxSpeed as REPORTED ", walks.map((w) => w.seg.maxSpeed));
dist("maxSpeed from OWN fix", walks.filter((w) => w.ownMax !== null).map((w) => w.ownMax));

// A segment whose reported maxSpeed exceeds what its own fixes support is
// describing a window it no longer covers.
const inherited = walks.filter((w) => w.ownMax !== null && w.seg.maxSpeed > w.ownMax + 0.5);
console.log(
	`\n${inherited.length} of ${walks.length} walking segments report a maxSpeed their OWN fixes do not support\n`,
);

const flagged = walks.filter((w) => w.seg.maxSpeed >= minKmh).sort((a, b) => b.seg.maxSpeed - a.seg.maxSpeed);
console.log(`=== ${flagged.length} walking segments with reported maxSpeed >= ${minKmh} km/h ===\n`);
for (const { date, seg, prev, next, ownMax, ownPts } of flagged) {
	const side = (s) => (s ? `${mode(s)}@${s.maxSpeed}` : "—");
	const flag = ownMax !== null && seg.maxSpeed > ownMax + 0.5 ? " INHERITED" : "";
	console.log(
		`${date} ${hm(seg.startTs)}-${hm(seg.endTs)} ${String(seg.endTs - seg.startTs).padStart(4)}s ` +
			`max=${String(seg.maxSpeed).padStart(6)} own=${String(ownMax).padStart(6)} ` +
			`pts=${String(seg.pointCount).padStart(3)}/${String(ownPts).padStart(3)}  ` +
			`[${side(prev)} | ${side(next)}]${flag}`,
	);
	for (const r of (seg.refinedReason ?? "").split(";").filter((x) => x.trim())) console.log(`      · ${r.trim()}`);
}
