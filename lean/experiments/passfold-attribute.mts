/**
 * WHICH pass first makes the two arms disagree?
 *
 * Every one of the 16 diverging golden days shows the same three fields —
 * `refinedMode`, `wayName`, `refinedReason` — on one to three segments (#424
 * step 3). That is one class, and this asks what accounts for it.
 *
 * WHAT THIS DOES NOT DO, because the obvious version of it does not work: it
 * does not name the pass by walking `trace` and reporting the first one whose
 * output differs at the segment's index. Passes SPLIT and MERGE, so index 15
 * after the fold is not index 15 before it, and that comparison reports the
 * first pass every time regardless. It was written, it said
 * `stationaryCoherence`, and that was an artefact.
 *
 * What it reports instead is the field set and the `unfed` list, which together
 * are enough: a difference confined to exactly the fields one unfed callback
 * writes is that callback's absence, not a divergence. `reenrichSplitWalks`
 * (`velocity.ts:1452`) sends `needsReenrich` segments through
 * `enrichMovingSegment`, which writes `refinedMode` / `wayName` /
 * `refinedReason` and nothing else.
 *
 * Attributing the pass properly needs leg identity rather than an index, which
 * is #409 and not built.
 *
 * Run: TMPDIR=/tmp npx tsx lean/experiments/passfold-attribute.mts [date]
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inputsFromFixture, parseCapturedDay } from "../../src/cli/fixture-day.js";
import type { OsmTrace } from "../../src/geo/osm-adapter-recording.js";
import { computeVelocityFromInputs } from "../../src/geo/velocity.js";
import type { FoldCaptureFile } from "../../src/lean/fold-capture.js";
import { buildDayRequest, encodeSeg } from "../../src/lean/fold-payload.js";

const ROOT = path.join(import.meta.dirname, "../..");
const DAYS_DIR = path.join(ROOT, "tests/golden/days");
const CLI = path.join(ROOT, "lean/.lake/build/bin/verified_cli");
const FIELDS = ["refinedMode", "wayName", "refinedReason"];

const date = process.argv[2] ?? "2026-05-18";
const file = readdirSync(DAYS_DIR).find((f) => f.startsWith(date));
if (file === undefined) throw new Error(`no fixture for ${date}`);
const captured = parseCapturedDay(readFileSync(path.join(DAYS_DIR, file), "utf8"));

const capDir = mkdtempSync(path.join(tmpdir(), "foldattr-"));
process.env.FOLD_CAPTURE = capDir;
const inputs = inputsFromFixture(captured, "rows");

// The same recorder the parity harness uses — see #428 for why the fixture's
// own `osmTrace` is the wrong source.
const rec: OsmTrace = {
	nearbyWays: {},
	nearbyStations: {},
	nearbyLandmarks: {},
	linesAtPoint: {},
	reverseGeocode: {},
	nearbyTransitStops: {},
	stationsOnLine: captured.inputs.osmTrace.stationsOnLine,
};
const key = (lat: number, lon: number, r: number | undefined): string => `${lat}|${lon}|${r ?? ""}`;
for (const [name, section] of [
	["nearbyWays", rec.nearbyWays],
	["nearbyStations", rec.nearbyStations],
	["linesAtPoint", rec.linesAtPoint],
	["nearbyTransitStops", rec.nearbyTransitStops as Record<string, unknown>],
] as const) {
	const osm = inputs.osm as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
	const inner = osm[name].bind(inputs.osm);
	osm[name] = async (lat: unknown, lon: unknown, r?: unknown) => {
		const v = await inner(lat, lon, r);
		(section as Record<string, unknown>)[key(lat as number, lon as number, r as number | undefined)] =
			name === "linesAtPoint" ? [...(v as Set<string>)] : v;
		return v;
	};
}

await computeVelocityFromInputs(inputs);
delete process.env.FOLD_CAPTURE;
const cap = JSON.parse(readFileSync(path.join(capDir, readdirSync(capDir)[0]), "utf8")) as FoldCaptureFile;

const raw = execFileSync(CLI, ["day"], {
	input: JSON.stringify(buildDayRequest(cap, captured, rec)),
	env: { ...process.env, LEAN_ABORT_ON_PANIC: "1" },
	maxBuffer: 512 * 1024 * 1024,
	encoding: "utf8",
});
const res = JSON.parse(raw) as {
	segs: Record<string, unknown>[];
	passes: string[];
	unfed: string[];
};

const want = cap.segsOut.map(encodeSeg) as Record<string, unknown>[];
const differing = want
	.map((_, i) => i)
	.filter((i) => res.segs[i] !== undefined && FIELDS.some((f) => JSON.stringify(want[i][f]) !== JSON.stringify(res.segs[i][f])));

console.log(`${date}: ${differing.length} of ${want.length} segments differ on ${FIELDS.join("/")}`);
console.log(`unfed callbacks: ${res.unfed.join(", ")}\n`);

for (const i of differing) {
	console.log(`segment ${i}  ${want[i].startTs}..${want[i].endTs}  mode=${want[i].mode}`);
	for (const f of FIELDS) {
		console.log(`  ${f.padEnd(14)} TS ${JSON.stringify(want[i][f])}   Lean ${JSON.stringify(res.segs[i][f])}`);
	}
	const leanAllNull = FIELDS.every((f) => res.segs[i][f] === null);
	console.log(`  Lean left all three unset: ${leanAllNull}\n`);
}
