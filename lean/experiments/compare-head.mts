#!/usr/bin/env -S npx tsx
/**
 * `verified_cli head` vs the TS it replaces — the pipeline head (#975/#982).
 *
 * `snapToPlace` and `classifySegments` are the two TS algorithm steps between
 * the raw fixes and `segsRaw`, the day fold's only input. Both had complete,
 * `#guard`-pinned Lean twins that NOTHING CALLED until the `head` verb existed;
 * this checks the verb actually agrees with the TS, which a guard against
 * hand-written fixtures cannot tell you.
 *
 * Floats are compared with `===` on the decoded bits, not a tolerance: the day
 * gate compares byte-exact, so anything short of identical is a divergence.
 *
 * Run: npx tsx lean/experiments/compare-head.mts   (needs lake build first)
 */
import { execFileSync } from "node:child_process";
import { floatFromBits, floatToBits } from "../../src/lean/float-bits.js";
import { classifySegments } from "../../src/geo/segments.js";
import { type KnownPlace, snapToPlace } from "../../src/geo/place-snap.js";

const CLI = "lean/.lake/build/bin/verified_cli";
const run = (req: unknown) =>
	JSON.parse(execFileSync(CLI, ["head"], { input: JSON.stringify(req), encoding: "utf8" }));

const places: KnownPlace[] = [
	{ centroidLat: 51.5205, centroidLon: -0.1, radiusM: 15, id: "home" },
	{ centroidLat: 51.524, centroidLon: -0.1, radiusM: 15, id: "cafe" },
];
const fixes: Array<{ lat: number; lon: number; accuracy: number | null }> = [
	{ lat: 51.52068, lon: -0.1, accuracy: 10 }, // precise: trusted as-is
	{ lat: 51.52068, lon: -0.1, accuracy: 50 }, // noisy: snaps
	{ lat: 51.52068, lon: -0.1, accuracy: null }, // unknown accuracy: still snaps
	{ lat: 51.6, lon: -0.1, accuracy: 50 }, // out of radius: no snap
	// ⚠ Already AT the centroid. It SNAPS without moving, so a check that
	// inferred "snapped" from whether the coordinates changed would call this a
	// non-snap. That is why the verb returns the flag rather than the geometry.
	{ lat: 51.5205, lon: -0.1, accuracy: 50 },
];

const snapResp = run({
	op: "snap",
	fixes: fixes.map((f) => [
		floatToBits(f.lat),
		floatToBits(f.lon),
		f.accuracy === null ? null : floatToBits(f.accuracy),
	]),
	places: places.map((p) => [
		floatToBits(p.centroidLat),
		floatToBits(p.centroidLon),
		p.radiusM === undefined ? null : floatToBits(p.radiusM),
		p.id ?? null,
	]),
});
if (snapResp.error) throw new Error(`lean snap: ${snapResp.error}`);

let snapBad = 0;
fixes.forEach((f, i) => {
	const ts = snapToPlace({ lat: f.lat, lon: f.lon, accuracy: f.accuracy }, places);
	const [la, lo, acc, moved] = snapResp.snapped[i];
	const ok =
		floatFromBits(la) === ts.lat &&
		floatFromBits(lo) === ts.lon &&
		(acc === null ? ts.accuracy === null : floatFromBits(acc) === ts.accuracy) &&
		moved === ts.snapped;
	if (!ok) {
		snapBad++;
		// Print EVERY compared field, not just lat/snapped. A first version printed
		// those two, and a deliberate red test reported three mismatches whose
		// printed values were identical — the field that actually differed was
		// `accuracy`, and the message hid it.
		const show = (lat: number, lon: number, acc: number | null, sn: boolean) =>
			`lat=${lat} lon=${lon} acc=${acc} snapped=${sn}`;
		console.log(`  MISMATCH fix ${i}`);
		console.log(`    lean ${show(floatFromBits(la), floatFromBits(lo), acc === null ? null : floatFromBits(acc), moved)}`);
		console.log(`    ts   ${show(ts.lat, ts.lon, ts.accuracy, ts.snapped)}`);
	}
});
console.log(`snap:     ${fixes.length - snapBad}/${fixes.length} identical`);

// A stationary run then a walking run: two segments, so the fixture pins the
// CUT as well as the classification.
const pts = Array.from({ length: 40 }, (_, i) => ({
	ts: i * 60,
	lat: 51.5 + (i < 20 ? 0 : (i - 20) * 0.0008),
	lon: -0.1,
	speed_kmh: i < 20 ? 0.2 : 4.6,
	bearing: 0,
}));
const segResp = run({
	op: "segments",
	pts: pts.map((p) => [
		p.ts,
		floatToBits(p.lat),
		floatToBits(p.lon),
		floatToBits(p.speed_kmh),
		floatToBits(p.bearing),
	]),
	stayPts: null,
});
if (segResp.error) throw new Error(`lean segments: ${segResp.error}`);

const tsSegs = classifySegments(pts as never);
let segBad = 0;
tsSegs.forEach((t, i) => {
	const l = segResp.segs[i];
	if (!l) {
		segBad++;
		console.log(`  MISSING seg ${i}`);
		return;
	}
	const same =
		l.startTs === t.startTs &&
		l.endTs === t.endTs &&
		l.mode === t.mode &&
		floatFromBits(l.confidence) === t.confidence &&
		floatFromBits(l.confidenceMargin) === t.confidenceMargin &&
		floatFromBits(l.avgSpeed) === t.avgSpeed &&
		floatFromBits(l.maxSpeed) === t.maxSpeed &&
		floatFromBits(l.linearity) === t.linearity &&
		l.pointCount === t.pointCount;
	if (!same) {
		segBad++;
		console.log(`  MISMATCH seg ${i}: lean=${l.mode} ${l.startTs}-${l.endTs} ts=${t.mode} ${t.startTs}-${t.endTs}`);
	}
});
const countOk = segResp.segs.length === tsSegs.length;
console.log(`segments: ${tsSegs.length - segBad}/${tsSegs.length} identical (lean ${segResp.segs.length} vs ts ${tsSegs.length})`);

const clean = snapBad === 0 && segBad === 0 && countOk;
console.log(clean ? "IDENTICAL" : "DIVERGED");
// `process.exitCode`, NOT `process.exit` — the corpus pass below runs after
// this, and exiting here skipped it silently while still printing a cheerful
// IDENTICAL for the synthetic cases alone.
if (!clean) process.exitCode = 1;

// ---------------------------------------------------------------------------
// The same two ops over the GOLDEN CORPUS — real tracks, not the fixtures above.
//
// The synthetic cases pin the branches; this pins the port against days that
// actually happened, which is what the other tenants had before they were
// staged (`compare-gpsquality.mts`, `compare-kalman.mts`). It mirrors
// `velocity.ts`'s head exactly:
//
//     inDay → qualityFilterGps → cleaned → snapToPlace → snapped
//           → ≤200 m filter → gpsPoints → filterGpsTrack → points
//           → classifySegments → segsRaw
//
// ⚠ NOTHING FROM A FIXTURE IS PRINTED. These days hold real coordinates, place
// names and biometrics. Only counts, dates and INDICES leave this file — an
// index says which fix disagreed without saying where it was.
//
// Skipped silently when the corpus is absent (it is gitignored), so this stays
// runnable on a machine that has never captured one.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filterGpsTrack } from "../../src/geo/kalman.js";
import { qualityFilterGps } from "../../src/geo/gps-quality.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const daysDir = path.join(here, "..", "..", "tests", "golden", "days");

let corpusFiles: string[] = [];
try {
	corpusFiles = readdirSync(daysDir)
		.filter((f) => f.endsWith(".json"))
		.sort();
} catch {
	corpusFiles = [];
}

if (corpusFiles.length === 0) {
	console.log("corpus:   (no golden days locally — skipped)");
} else {
	let snapBadDays = 0;
	let segBadDays = 0;
	let snapCalls = 0;
	let segCalls = 0;

	for (const file of corpusFiles) {
		const fx = JSON.parse(readFileSync(path.join(daysDir, file), "utf8"));
		const pt = fx.inputs.phonetrack ?? {};
		const raw = [...(pt.priorEvening ?? []), ...(pt.morning ?? []), ...(pt.today ?? [])]
			.sort((a: { ts: number }, b: { ts: number }) => a.ts - b.ts)
			.map((p: { ts: number; lat: number; lon: number; accuracy?: number | null }) => ({
				ts: p.ts,
				lat: p.lat,
				lon: p.lon,
				accuracy: p.accuracy ?? null,
			}));
		if (raw.length === 0) continue;

		const cleaned = qualityFilterGps(raw as never) as Array<{
			ts: number;
			lat: number;
			lon: number;
			accuracy: number | null;
		}>;
		const known = (fx.inputs.knownPlaces ?? []) as KnownPlace[];
		if (cleaned.length === 0 || known.length === 0) continue;

		// --- snap, the whole day in one call ---
		const resp = run({
			op: "snap",
			fixes: cleaned.map((f) => [
				floatToBits(f.lat),
				floatToBits(f.lon),
				f.accuracy === null ? null : floatToBits(f.accuracy),
			]),
			places: known.map((p) => [
				floatToBits(p.centroidLat),
				floatToBits(p.centroidLon),
				p.radiusM === undefined ? null : floatToBits(p.radiusM),
				p.id === undefined ? null : String(p.id),
			]),
		});
		if (resp.error) throw new Error(`${file} snap: ${resp.error}`);
		snapCalls++;

		const badFix: number[] = [];
		const leanSnapped = cleaned.map((f, i) => {
			const [la, lo, acc, moved] = resp.snapped[i];
			const t = snapToPlace({ lat: f.lat, lon: f.lon, accuracy: f.accuracy }, known);
			const ok =
				floatFromBits(la) === t.lat &&
				floatFromBits(lo) === t.lon &&
				(acc === null ? t.accuracy === null : floatFromBits(acc) === t.accuracy) &&
				moved === t.snapped;
			if (!ok) badFix.push(i);
			return moved ? { ...f, lat: floatFromBits(la), lon: floatFromBits(lo), accuracy: acc === null ? null : floatFromBits(acc) } : f;
		});
		if (badFix.length > 0) {
			snapBadDays++;
			console.log(`  ${file.slice(0, 10)} snap: ${badFix.length}/${cleaned.length} differ at [${badFix.slice(0, 8)}]`);
		}

		// --- segments, over the Kalman-filtered track ---
		const within = leanSnapped.filter((p) => p.accuracy === null || p.accuracy <= 200);
		const gpsPoints = within.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy }));
		const stayPts = within.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon }));
		if (gpsPoints.length === 0) continue;
		const filtered = filterGpsTrack(gpsPoints as never) as Array<{
			ts: number;
			lat: number;
			lon: number;
			speed_kmh: number;
			bearing: number;
		}>;
		if (filtered.length === 0) continue;

		const segResp2 = run({
			op: "segments",
			pts: filtered.map((p) => [
				p.ts,
				floatToBits(p.lat),
				floatToBits(p.lon),
				floatToBits(p.speed_kmh),
				floatToBits(p.bearing),
			]),
			stayPts: stayPts.map((p) => [p.ts, floatToBits(p.lat), floatToBits(p.lon)]),
		});
		if (segResp2.error) throw new Error(`${file} segments: ${segResp2.error}`);
		segCalls++;

		const tsSegs2 = classifySegments(filtered as never, stayPts as never);
		const badSeg: number[] = [];
		if (segResp2.segs.length !== tsSegs2.length) {
			segBadDays++;
			console.log(`  ${file.slice(0, 10)} segments: count lean=${segResp2.segs.length} ts=${tsSegs2.length}`);
		} else {
			tsSegs2.forEach((t: (typeof tsSegs2)[number], i: number) => {
				const l = segResp2.segs[i];
				const same =
					l.startTs === t.startTs &&
					l.endTs === t.endTs &&
					l.mode === t.mode &&
					l.pointCount === t.pointCount &&
					floatFromBits(l.confidence) === t.confidence &&
					floatFromBits(l.confidenceMargin) === t.confidenceMargin &&
					floatFromBits(l.avgSpeed) === t.avgSpeed &&
					floatFromBits(l.maxSpeed) === t.maxSpeed &&
					floatFromBits(l.linearity) === t.linearity &&
					(l.refinedReason ?? null) === (t.refinedReason ?? null) &&
					(l.refinedKinds ?? []).join(" ") === (t.refinedKinds ?? []).join(" ");
				if (!same) badSeg.push(i);
			});
			if (badSeg.length > 0) {
				segBadDays++;
				console.log(`  ${file.slice(0, 10)} segments: ${badSeg.length}/${tsSegs2.length} differ at [${badSeg.slice(0, 8)}]`);
			}
		}
	}

	console.log(`corpus snap:     ${snapCalls - snapBadDays}/${snapCalls} day(s) identical`);
	console.log(`corpus segments: ${segCalls - segBadDays}/${segCalls} day(s) identical`);
	if (snapBadDays > 0 || segBadDays > 0) process.exitCode = 1;
}
