#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `annotateWalkMatches`
 * (`src/geo/pedestrian-match-annotate.ts`), ported into
 * `Verified/Geo/WalkAnnotate.lean`.
 *
 * The pass is an ORCHESTRATOR: every heavy step — the Viterbi matcher, the MAP
 * reconstruction, the corner refinement, the building corrector, the passage
 * snap — is a leaf that already has its own Lean module and its own pinned
 * reference values. What is unpinned, and what this generator exists for, is
 * everything BETWEEN those calls: which legs are eligible, what disc each leg
 * reads, which arm draws, and which of the three output shapes the leg leaves
 * with.
 *
 * So each case prints two things:
 *
 *   1. the OSM read trace — one line per `walkableRoads` / `buildingsNear`
 *      call, with the coordinates and radius, which pins the centroid and the
 *      disc arithmetic; and
 *   2. the leg's verdict — which path field it came out with, and that path's
 *      vertex count / drawn length / endpoints.
 *
 * The leaf outputs the orchestration consumes are printed SEPARATELY, by
 * calling the exported leaves on the same inputs the pass hands them. Those are
 * what the Lean guards' injected stubs replay, so the orchestration is pinned
 * against V8 without the guard having to re-run a PCG solve in the interpreter.
 *
 * Run: npx tsx lean/experiments/walk-annotate-refs.mts
 */
import path from "node:path";

type PedFix = { ts: number; lat: number; lon: number; accuracy: number | null };
type Way = { osmId: number; name: string | null; subtype: string | null; coords: Array<[number, number]> };
type Ring = Array<{ lat: number; lon: number }>;
// biome-ignore lint/suspicious/noExplicitAny: reference harness feeds the real pass structural fixtures.
type Seg = any;

const n6 = (x: number): string => x.toFixed(6);

/** A walking segment. `mode` stays raw so `refinedMode` can be exercised. */
const seg = (startTs: number, endTs: number, mode: TransportMode, extra: Record<string, unknown> = {}): Seg => ({
	startTs,
	endTs,
	mode,
	confidence: 1,
	confidenceMargin: 2,
	avgSpeed: 4,
	maxSpeed: 6,
	linearity: 0.9,
	pointCount: 10,
	...extra,
});

const f = (ts: number, lat: number, lon: number, accuracy: number | null = 10): PedFix => ({ ts, lat, lon, accuracy });

/** A north-south street on the -0.14 meridian, and an east-west one crossing
 *  it, so the walkable graph can actually route a corner. */
const STREETS: Way[] = [
	{
		osmId: 1,
		name: "Meridian Street",
		subtype: "residential",
		coords: [
			[51.5, -0.14],
			[51.502, -0.14],
			[51.504, -0.14],
		],
	},
	{
		osmId: 2,
		name: "Cross Street",
		subtype: "footway",
		coords: [
			[51.502, -0.14],
			[51.502, -0.137],
		],
	},
];

/** One footprint straddling the corner-cutting chord. */
const BLOCK: Ring[] = [
	[
		{ lat: 51.5012, lon: -0.1397 },
		{ lat: 51.5012, lon: -0.1388 },
		{ lat: 51.502, lon: -0.1388 },
		{ lat: 51.502, lon: -0.1397 },
	],
];

/** A graph staircase: eight ~90° corners where the walk really went diagonally.
 *  The matched line inherits every corner; the refinement's whole mandate is to
 *  round them back toward the fixes. */
const STAIRS: Way[] = [
	{
		osmId: 3,
		name: "Staircase Way",
		subtype: "footway",
		coords: [
			[51.5, -0.14],
			[51.501, -0.14],
			[51.501, -0.1392],
			[51.502, -0.1392],
			[51.502, -0.1384],
			[51.503, -0.1384],
		],
	},
];

/** A way THROUGH the footprint below, 26 m east of the off-network fixes: past
 *  the matcher's 20 m candidate radius, inside the passage snap's reach. */
const PASSAGE: Way[] = [
	...STREETS,
	{
		osmId: 4,
		name: "Arcade",
		subtype: "footway",
		coords: [
			[51.4998, -0.14512],
			[51.5022, -0.14512],
		],
	},
];

const ARCADE_BLOCK: Ring[] = [
	[
		{ lat: 51.5, lon: -0.146 },
		{ lat: 51.5, lon: -0.1445 },
		{ lat: 51.502, lon: -0.1445 },
		{ lat: 51.502, lon: -0.146 },
	],
];

interface ReadLog {
	kind: "ways" | "buildings";
	lat: number;
	lon: number;
	radiusM: number;
}

/** The only two adapter methods this pass calls. Everything else throws, so a
 *  silently-added lookup shows up as a failure rather than as a fixture that
 *  quietly stops matching production. */
function adapter(ways: Way[], buildings: Ring[], log: ReadLog[]): unknown {
	const boom = (name: string) => () => {
		throw new Error(`unexpected OsmAdapter.${name}`);
	};
	return {
		walkableRoads: async (lat: number, lon: number, radiusM: number) => {
			log.push({ kind: "ways", lat, lon, radiusM });
			return ways;
		},
		buildingsNear: async (lat: number, lon: number, radiusM: number) => {
			log.push({ kind: "buildings", lat, lon, radiusM });
			return buildings;
		},
		nearbyWays: boom("nearbyWays"),
		nearbyStations: boom("nearbyStations"),
		nearbyLandmarks: boom("nearbyLandmarks"),
		linesAtPoint: boom("linesAtPoint"),
		reverseGeocode: boom("reverseGeocode"),
		nearbyTransitStops: boom("nearbyTransitStops"),
		stationsOnLine: boom("stationsOnLine"),
		drivableRoads: boom("drivableRoads"),
	};
}

function pathLenM(pts: ReadonlyArray<{ lat: number; lon: number }>): number {
	const R = 6371000;
	let total = 0;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1];
		const b = pts[i];
		const dLat = ((b.lat - a.lat) * Math.PI) / 180;
		const dLon = ((b.lon - a.lon) * Math.PI) / 180;
		const h =
			Math.sin(dLat / 2) ** 2 +
			Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
		total += 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
	}
	return total;
}

function describe(s: Seg): string {
	const p = s.walkSmoothedPath ?? s.walkMatchedPath;
	const field = s.walkSmoothedPath ? "smoothed" : s.walkMatchedPath ? "matched" : "raw";
	if (p === undefined) return `${field} (no path)`;
	return `${field} n=${p.length} len=${pathLenM(p).toFixed(4)} first=${n6(p[0].lat)},${n6(p[0].lon)}@${p[0].ts} last=${n6(p[p.length - 1].lat)},${n6(p[p.length - 1].lon)}@${p[p.length - 1].ts}`;
}

interface CaseOpts {
	segments: Seg[];
	fixes: PedFix[];
	speeds?: Map<number, number>;
	steps?: Array<{ ts: number; steps: number }>;
	ways?: Way[];
	buildings?: Ring[];
	draw?: "matcher" | "recon";
	env?: Record<string, string | undefined>;
}

async function run(title: string, o: CaseOpts): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(o.env ?? {})) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	const log: ReadLog[] = [];
	// The speed track the pass reads. It carries the fix's own position and
	// bearing so it is a real `FilteredPoint` rather than a two-field stand-in —
	// only `ts` and `speed_kmh` are read here, but a narrower shape is how the
	// harness stops tracking what production hands the pass (#418).
	const points = o.fixes.map((x) => ({
		ts: x.ts,
		lat: x.lat,
		lon: x.lon,
		bearing: 0,
		speed_kmh: o.speeds?.get(x.ts) ?? 4,
	}));
	const out = await A.annotateWalkMatches(
		o.segments,
		o.fixes,
		points,
		adapter(o.ways ?? STREETS, o.buildings ?? [], log) as Parameters<typeof A.annotateWalkMatches>[3],
		o.steps ?? [],
		o.draw ?? "matcher",
	);
	console.log(`--- ${title}`);
	for (const r of log) console.log(`    read ${r.kind} ${n6(r.lat)},${n6(r.lon)} r=${r.radiusM}`);
	for (const s of out) console.log(`    seg[${s.startTs},${s.endTs}] ${describe(s)}`);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

/* ------------------------------------------------------------------ *
 * Fixtures                                                            *
 * ------------------------------------------------------------------ */

/** Five fixes walking north ALONG Meridian Street. The raw line already rides
 *  the walkable network, so the display gate has nothing to improve. */
const WALKING: PedFix[] = [
	f(1000, 51.5, -0.14),
	f(1060, 51.5005, -0.14),
	f(1120, 51.501, -0.14),
	f(1180, 51.5015, -0.14),
	f(1240, 51.502, -0.14),
];

/** The same walk, but turning east at the junction with a fix missing at the
 *  corner itself — so the RAW chord cuts diagonally across the block while
 *  every fix still sits on a way. That is the gate's whole premise: judge the
 *  drawn line, not the fixes. */
const CORNER: PedFix[] = [
	f(1000, 51.5, -0.14),
	f(1060, 51.501, -0.14),
	f(1120, 51.502, -0.1385),
	f(1180, 51.502, -0.1378),
	f(1240, 51.502, -0.137),
];

/** Three fixes — below `MIN_LEG_FIXES`. */
const TOO_FEW: PedFix[] = [f(1000, 51.5, -0.14), f(1060, 51.5005, -0.14), f(1120, 51.501, -0.14)];

/** Five fixes on open ground ~380 m west of every way: nothing within the
 *  matcher's 20 m candidate radius, so it bails and the raw line draws. */
const OFFROAD: PedFix[] = [
	f(1000, 51.5, -0.1455),
	f(1060, 51.5005, -0.1455),
	f(1120, 51.501, -0.1455),
	f(1180, 51.5015, -0.1455),
	f(1240, 51.502, -0.1455),
];

/** The straight walk with a lone 350 m westward juttion at 1120: `rejectSpikes`
 *  drops it, leaving four — exactly `MIN_LEG_FIXES`. */
const SPIKED: PedFix[] = [
	f(1000, 51.5, -0.14),
	f(1060, 51.5005, -0.14),
	f(1120, 51.5015, -0.145),
	f(1180, 51.5015, -0.14),
	f(1240, 51.502, -0.14),
];

/** Two spikes — `rejectSpikes` leaves three, below the bar. */
const SPIKED_TWICE: PedFix[] = [
	f(1000, 51.5, -0.14),
	f(1060, 51.5005, -0.145),
	f(1120, 51.501, -0.14),
	f(1180, 51.5015, -0.145),
	f(1240, 51.502, -0.14),
];

/** A 600 m hop in 60 s (36 km/h) at 1120: past `rejectSpikes` (it returns to
 *  the line, so the detour is not an out-and-back apex) but well over the 12
 *  km/h walking cap, so `holdImplausibleSpeed` cuts the leg at the longest
 *  plausible run. */
const TELEPORTED: PedFix[] = [
	f(1000, 51.5, -0.14),
	f(1060, 51.5005, -0.14),
	f(1120, 51.507, -0.14),
	f(1180, 51.5075, -0.14),
	f(1240, 51.508, -0.14),
];

function prepOf(name: string, fx: PedFix[]): void {
	const cLat = fx.reduce((a, p) => a + p.lat, 0) / fx.length;
	const cLon = fx.reduce((a, p) => a + p.lon, 0) / fx.length;
	console.log(`    ${name} centroid ${n6(cLat)},${n6(cLon)}  (raw ${cLat} ${cLon})`);
	let maxD = 0;
	for (const p of fx) {
		const d = pathLenM([{ lat: cLat, lon: cLon }, p]);
		if (d > maxD) maxD = d;
	}
	console.log(`    ${name} maxDist ${maxD}  radius ${Math.round(maxD + 120)}`);
}

console.log("\n=== the pass ===");

await run("plain walking leg", { segments: [seg(1000, 1240, "walking")], fixes: WALKING });

await run("refinedMode walking over a raw non-walk mode", {
	segments: [seg(1000, 1240, "driving", { refinedMode: "walking" })],
	fixes: WALKING,
});

await run("non-walking leg is untouched and reads nothing", {
	segments: [seg(1000, 1240, "driving")],
	fixes: WALKING,
});

await run("three fixes — below MIN_LEG_FIXES, reads nothing", {
	segments: [seg(1000, 1120, "walking")],
	fixes: TOO_FEW,
});

await run("a fix over the walking speed cap is excluded from the window", {
	segments: [seg(1000, 1240, "walking")],
	fixes: WALKING,
	speeds: new Map([[1120, 13]]),
});

await run("empty ways — no buildings read, leg untouched", {
	segments: [seg(1000, 1240, "walking")],
	fixes: WALKING,
	ways: [],
});

await run("WALK_MATCH_DISABLE=1 — whole pass is a no-op", {
	segments: [seg(1000, 1240, "walking")],
	fixes: WALKING,
	env: { WALK_MATCH_DISABLE: "1" },
});

await run("corner-cutting raw line — the gate has something to fix", {
	segments: [seg(1000, 1240, "walking")],
	fixes: CORNER,
});

await run("corner + buildings — corrector arm eligible", {
	segments: [seg(1000, 1240, "walking")],
	fixes: CORNER,
	buildings: BLOCK,
});

await run("corner + buildings, WALK_BUILDING_ESCAPE=0", {
	segments: [seg(1000, 1240, "walking")],
	fixes: CORNER,
	buildings: BLOCK,
	env: { WALK_BUILDING_ESCAPE: "0" },
});

await run("corner, WALK_REFINE_DISABLE=1", {
	segments: [seg(1000, 1240, "walking")],
	fixes: CORNER,
	env: { WALK_REFINE_DISABLE: "1" },
});

await run("corner, WALK_RECON=0", {
	segments: [seg(1000, 1240, "walking")],
	fixes: CORNER,
	env: { WALK_RECON: "0" },
});

await run("draw=recon", { segments: [seg(1000, 1240, "walking")], fixes: WALKING, draw: "recon" });

await run("draw=recon with steps", {
	segments: [seg(1000, 1240, "walking")],
	fixes: WALKING,
	draw: "recon",
	steps: [
		{ ts: 1020, steps: 100 },
		{ ts: 1080, steps: 120 },
		{ ts: 1140, steps: 110 },
	],
});

await run("draw=recon on the corner", { segments: [seg(1000, 1240, "walking")], fixes: CORNER, draw: "recon" });

await run("WALK_RECON=0", { segments: [seg(1000, 1240, "walking")], fixes: WALKING, env: { WALK_RECON: "0" } });

await run("WALK_REFINE_DISABLE=1", {
	segments: [seg(1000, 1240, "walking")],
	fixes: WALKING,
	env: { WALK_REFINE_DISABLE: "1" },
});

await run("two walking legs — both read their own disc, ways first", {
	segments: [seg(1000, 1240, "walking"), seg(1300, 1540, "walking")],
	fixes: [...WALKING, ...CORNER.map((p) => ({ ...p, ts: p.ts + 300 }))],
});

await run("off-network — the matcher bails, the raw line draws", {
	segments: [seg(1000, 1240, "walking")],
	fixes: OFFROAD,
});

await run("off-network with a footprint under the line — the corrector arm", {
	segments: [seg(1000, 1240, "walking")],
	fixes: OFFROAD,
	buildings: [
		[
			{ lat: 51.5008, lon: -0.146 },
			{ lat: 51.5008, lon: -0.145 },
			{ lat: 51.5016, lon: -0.145 },
			{ lat: 51.5016, lon: -0.146 },
		],
	],
});

await run("one spike — rejectSpikes leaves exactly MIN_LEG_FIXES", {
	segments: [seg(1000, 1240, "walking")],
	fixes: SPIKED,
});

await run("two spikes — rejectSpikes drops below MIN_LEG_FIXES", {
	segments: [seg(1000, 1240, "walking")],
	fixes: SPIKED_TWICE,
});

await run("a teleport run — held by the speed cap, matched on the full clean set", {
	segments: [seg(1000, 1240, "walking")],
	fixes: TELEPORTED,
});

await run("teleport, draw=recon — the recon consumes the HELD fixes", {
	segments: [seg(1000, 1240, "walking")],
	fixes: TELEPORTED,
	draw: "recon",
});

/** The walk really cut the corners of a graph staircase. */
const DIAGONAL: PedFix[] = [
	f(1000, 51.5, -0.14),
	f(1060, 51.5005, -0.14),
	f(1120, 51.501, -0.1392),
	f(1180, 51.502, -0.1384),
	f(1240, 51.503, -0.1384),
];

await run("staircase — the refinement rounds the graph's corners", {
	segments: [seg(1000, 1240, "walking")],
	fixes: DIAGONAL,
	ways: STAIRS,
});

await run("staircase, WALK_REFINE_DISABLE=1 — the boxy line survives", {
	segments: [seg(1000, 1240, "walking")],
	fixes: DIAGONAL,
	ways: STAIRS,
	env: { WALK_REFINE_DISABLE: "1" },
});

/** Four fixes at walking pace, then a 215 m hop in 60 s. The matcher sees the
 *  straggler (`clean`) and draws out to it; the reconstruction sees only the
 *  held run and draws the honest short line — the dissolved-excursion
 *  signature the swap exists for. */
const STRAGGLER: PedFix[] = [
	f(1000, 51.5, -0.14),
	f(1060, 51.5005, -0.14),
	f(1120, 51.501, -0.14),
	f(1180, 51.5015, -0.14),
	f(1240, 51.502, -0.137),
];

await run("straggler — the reconstruction swap fires on the matcher arm", {
	segments: [seg(1000, 1240, "walking")],
	fixes: STRAGGLER,
});

await run("straggler, WALK_RECON=0 — the swap is the only difference", {
	segments: [seg(1000, 1240, "walking")],
	fixes: STRAGGLER,
	env: { WALK_RECON: "0" },
});

/** A long corner cut (so the display gate engages) followed by a TIGHT
 *  staircase — corners clustered inside the refinement's 25 m neighbour
 *  radius, which is the artifact signature it is allowed to round. */
const TIGHT: Way[] = [
	{
		osmId: 5,
		name: "Tight Way",
		subtype: "footway",
		coords: [
			[51.5, -0.14],
			[51.502, -0.14],
			[51.502, -0.138],
			[51.5021, -0.138],
			[51.5021, -0.1378],
			[51.5022, -0.1378],
			[51.5022, -0.1376],
			[51.5023, -0.1376],
			[51.5023, -0.1374],
		],
	},
];

const TIGHT_FIXES: PedFix[] = [
	f(1000, 51.5, -0.14),
	f(1060, 51.501, -0.14),
	f(1120, 51.502, -0.138),
	f(1180, 51.50215, -0.1377),
	f(1240, 51.5023, -0.1374),
];

await run("tight staircase — the refinement engages", {
	segments: [seg(1000, 1240, "walking")],
	fixes: TIGHT_FIXES,
	ways: TIGHT,
});

await run("tight staircase, WALK_REFINE_DISABLE=1", {
	segments: [seg(1000, 1240, "walking")],
	fixes: TIGHT_FIXES,
	ways: TIGHT,
	env: { WALK_REFINE_DISABLE: "1" },
});

/** Meridian Street bowed east between the endpoints: the route carries curve
 *  geometry the coarse matched line does not, so `path` and `coarsePath`
 *  genuinely differ and it is visible WHICH one each consumer reads. */
const CURVED: Way[] = [
	{
		osmId: 6,
		name: "Bowed Street",
		subtype: "residential",
		coords: [
			[51.5, -0.14],
			[51.5005, -0.1398],
			[51.501, -0.1397],
			[51.5015, -0.1398],
			[51.502, -0.14],
			[51.504, -0.14],
		],
	},
	STREETS[1],
];

await run("curved way — the drawn line is the FINE path, the gate reads coarse", {
	segments: [seg(1000, 1240, "walking")],
	fixes: CORNER,
	ways: CURVED,
});

/** Six fixes riding Meridian Street then two in an unmapped forecourt 62 m
 *  east. The raw line goes out there (rawOff > 2× the needs-match bar), the
 *  match is clean (matchedOff ≤ half the bar), but p85 stray clears 40 — the
 *  ONE shape the splice salvage exists for. */
const FORECOURT: PedFix[] = [
	f(1000, 51.5, -0.14),
	f(1060, 51.5004, -0.14),
	f(1120, 51.5008, -0.14),
	f(1180, 51.5012, -0.14),
	f(1240, 51.5016, -0.14),
	f(1300, 51.502, -0.14),
	f(1360, 51.5022, -0.1391),
	f(1420, 51.5024, -0.1391),
];

await run("forecourt — the stray gate rejects, the splice salvages", {
	segments: [seg(1000, 1420, "walking")],
	fixes: FORECOURT,
	ways: [STREETS[0]],
});

await run("arcade — a mapped passage under the footprint the line crosses", {
	segments: [seg(1000, 1240, "walking")],
	fixes: OFFROAD,
	ways: PASSAGE,
	buildings: ARCADE_BLOCK,
});

await run("arcade with a step budget — the corrector's stepBudgetM arm", {
	segments: [seg(1000, 1240, "walking")],
	fixes: OFFROAD,
	ways: PASSAGE,
	buildings: ARCADE_BLOCK,
	steps: [
		{ ts: 1020, steps: 100 },
		{ ts: 1080, steps: 120 },
		{ ts: 1140, steps: 110 },
	],
});

await run("neighbouring stay contributes an endpoint anchor", {
	segments: [
		seg(600, 1000, "stationary", { centroidLat: 51.4999, centroidLon: -0.1401 }),
		seg(1000, 1240, "walking"),
	],
	fixes: WALKING,
	draw: "recon",
});

/* ------------------------------------------------------------------ *
 * The leaves, on the inputs the pass hands them                        *
 * ------------------------------------------------------------------ */

function leavesWith(name: string, fixes: PedFix[], buildings: Ring[], ways: Way[] = STREETS): void {
	console.log(`\n=== leaves on ${name} ===`);
	const clean = EG.rejectSpikes(fixes);
	console.log(`    rejectSpikes n=${clean.length} ts=${clean.map((p) => p.ts).join(",")}`);
	const held = EG.holdImplausibleSpeed(clean, 12);
	console.log(`    holdImplausibleSpeed n=${held.length} ts=${held.map((p) => p.ts).join(",")}`);
	const rf = clean.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts }));
	const mres = PM.matchWalkSegment(rf, { ways, buildings });
	if (mres === null) {
		console.log("    matchWalkSegment null");
		return;
	}
	for (const p of mres.path) console.log(`      path ${p.lat},${p.lon}@${p.ts}`);
	console.log(`    path n=${mres.path.length} len=${pathLenM(mres.path).toFixed(4)}`);
	for (const p of mres.coarsePath) console.log(`      coarse ${p.lat},${p.lon}@${p.ts}`);
	console.log(`    coarse n=${mres.coarsePath.length} len=${pathLenM(mres.coarsePath).toFixed(4)}`);
	const d = MMC.matchImprovesDisplay(rf, mres.coarsePath, { ways }, 18, 40);
	console.log(
		`    gate use=${d.use} rawOff=${d.rawOffRoadM} matchedOff=${d.matchedOffRoadM} stray=${d.strayM}`,
	);
	const sp = MMC.spliceMatchedWithDivergentRuns(rf, mres.coarsePath, 40);
	console.log(`    splice ${sp === null ? "null" : `n=${sp.length} sharp=${WSM.countSharpTurns(sp)}`}`);
	if (sp !== null) for (const p of sp) console.log(`      spliced ${p.lat},${p.lon}@${p.ts}`);
	if (sp !== null) {
		const wfs = clean.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts, accuracyM: p.accuracy ?? undefined }));
		const rs = WSM.refineMatchedPath(wfs, sp);
		console.log(`    refine-on-splice ${rs === null ? "null" : `n=${rs.length} sharp=${WSM.countSharpTurns(rs)}`}`);
	}
	const wf = clean.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts, accuracyM: p.accuracy ?? undefined }));
	const ref = WSM.refineMatchedPath(wf, mres.coarsePath);
	console.log(
		`    refine ${ref === null ? "null" : `n=${ref.length} sharp=${WSM.countSharpTurns(ref)}`} baseSharp=${WSM.countSharpTurns(mres.coarsePath)}`,
	);
	if (ref !== null) for (const p of ref) console.log(`      refined ${p.lat},${p.lon}@${p.ts}`);
	const heldWf = held.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts, accuracyM: p.accuracy ?? undefined }));
	const rec = WSM.reconstructWalk(heldWf, { ways, buildings }, undefined, {});
	if (rec === null) console.log("    reconstructWalk null");
	else {
		for (const p of rec) console.log(`      recon ${p.lat},${p.lon}@${p.ts}`);
		console.log(`    recon n=${rec.length} len=${pathLenM(rec).toFixed(4)}`);
	}
	if (buildings.length > 0) {
		const drawnRaw = held.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts }));
		const fixed = WBE.correctWalkPath(drawnRaw, { ways }, buildings);
		console.log(`    correctWalkPath(raw) n=${fixed.length} len=${pathLenM(fixed).toFixed(4)}`);
		const snapped = WBE.snapPassages(fixed, { ways }, buildings);
		console.log(`    snapPassages(corrected) n=${snapped.length} len=${pathLenM(snapped).toFixed(4)}`);
		for (const p of snapped) console.log(`      snapped ${p.lat},${p.lon}@${p.ts}`);
	}
}

leavesWith("the straight leg", WALKING, []);
leavesWith("the corner leg", CORNER, []);
leavesWith("the corner leg with the block", CORNER, BLOCK);
leavesWith("the off-network leg", OFFROAD, []);
leavesWith("the spiked leg", SPIKED, []);
leavesWith("the twice-spiked leg", SPIKED_TWICE, []);
leavesWith("the teleported leg", TELEPORTED, []);
leavesWith("the staircase leg", DIAGONAL, [], STAIRS);
leavesWith("the straggler leg", STRAGGLER, []);
leavesWith("the tight-staircase leg", TIGHT_FIXES, [], TIGHT);
leavesWith("the curved-way corner leg", CORNER, [], CURVED);
leavesWith("the forecourt leg", FORECOURT, [], [STREETS[0]]);

console.log("\n=== prep geometry (centroid + disc radius) ===");
prepOf("WALKING", WALKING);
prepOf("CORNER", CORNER);
prepOf("OFFROAD", OFFROAD);
prepOf("SPIKED", SPIKED);
prepOf("SPIKED_TWICE", SPIKED_TWICE);
prepOf("TELEPORTED", TELEPORTED);
prepOf("DIAGONAL", DIAGONAL);
prepOf("TIGHT_FIXES", TIGHT_FIXES);
prepOf("STRAGGLER", STRAGGLER);
prepOf("FORECOURT", FORECOURT);

/* ------------------------------------------------------------------ *
 * Synthetic decision probes                                           *
 *                                                                     *
 * The matcher is INJECTED in the Lean port, so a coarse/fine pair can  *
 * be handed to the gate and the salvage directly. These pin WHICH line *
 * each consumer reads and where its thresholds sit, without needing a  *
 * way network that happens to produce the pair.                        *
 * ------------------------------------------------------------------ */

console.log("\n=== synthetic decision probes ===");

const MER = [STREETS[0]];
const gate = (name: string, fixes: PedFix[], line: Array<{ lat: number; lon: number; ts: number }>): void => {
	const rf = fixes.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts }));
	const d = MMC.matchImprovesDisplay(rf, line, { ways: MER }, 18, 40);
	console.log(`    ${name} use=${d.use} rawOff=${d.rawOffRoadM} matchedOff=${d.matchedOffRoadM} stray=${d.strayM}`);
	const sp = MMC.spliceMatchedWithDivergentRuns(rf, line, 40);
	console.log(`    ${name} splice ${sp === null ? "null" : `n=${sp.length}`}`);
	if (sp !== null) for (const p of sp) console.log(`      ${name} spliced ${p.lat},${p.lon}@${p.ts}`);
};

/** The forecourt's coarse line — straight up the meridian. */
const F_COARSE = [
	{ lat: 51.5, lon: -0.14, ts: 1000 },
	{ lat: 51.502, lon: -0.14, ts: 1300 },
];
/** A FINE variant with an extra mid vertex: the same endpoints, a different
 *  polyline. Whatever consumes "the matched line" reveals which it got. */
const F_FINE = [
	{ lat: 51.5, lon: -0.14, ts: 1000 },
	{ lat: 51.501, lon: -0.1394, ts: 1150 },
	{ lat: 51.502, lon: -0.14, ts: 1300 },
];
gate("forecourt-coarse", FORECOURT, F_COARSE);
gate("forecourt-fine", FORECOURT, F_FINE);

/** Eleven fixes on the meridian and ONE 62 m off: p85 lands on a supported fix,
 *  so the gate PASSES — and the salvage must still not run. */
const ONEOFF: PedFix[] = [
	f(1000, 51.5, -0.14),
	f(1030, 51.5002, -0.14),
	f(1060, 51.5004, -0.14),
	f(1090, 51.5006, -0.14),
	f(1120, 51.5008, -0.14),
	f(1150, 51.501, -0.14),
	f(1180, 51.5012, -0.14),
	f(1210, 51.5014, -0.14),
	f(1240, 51.5016, -0.14),
	f(1270, 51.5018, -0.14),
	f(1300, 51.502, -0.14),
	f(1330, 51.5021, -0.1391),
];
prepOf("ONEOFF", ONEOFF);
gate("oneoff", ONEOFF, F_COARSE);

/** A matched line held 6 m off the meridian: matchedOff sits between the
 *  salvage's ÷2 bar (9 m) and its ×2 loosening (36 m). */
const OFFSET_LINE = [
	{ lat: 51.5, lon: -0.140086, ts: 1000 },
	{ lat: 51.502, lon: -0.140086, ts: 1300 },
];
gate("forecourt-offset6", FORECOURT, OFFSET_LINE);

/** …and one held 25 m off, above the ÷2 bar and below ×2. */
const OFFSET_25 = [
	{ lat: 51.5, lon: -0.14036, ts: 1000 },
	{ lat: 51.502, lon: -0.14036, ts: 1300 },
];
gate("forecourt-offset25", FORECOURT, OFFSET_25);

console.log("\n=== metersBetween (the pass's own haversine) ===");
const mb = (aLat: number, aLon: number, bLat: number, bLon: number): void => {
	console.log(`    ${aLat},${aLon} -> ${bLat},${bLon} = ${pathLenM([{ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon }])}`);
};
mb(51.5, -0.14, 51.502, -0.14);
mb(51.5, -0.14, 51.5, -0.137);
// Far apart on BOTH axes, and across the equator: the only shape in which the
// two cosines, the radius and the arcsine are each individually visible.
mb(0, 0, 51.5, -0.14);
mb(-33.86, 151.21, 51.5, -0.14);
mb(51.5, -0.14, -33.86, 151.21);

/** Two parallel ways 60 m apart. Six fixes ride the near one, two the far one:
 *  the crossing chord is ~30 m off both — past the needs-match bar but UNDER
 *  the salvage's 2x bar — while the far fixes sit 60 m from the matched line,
 *  so the gate rejects on stray alone. The one shape in which the salvage's
 *  rawOff bar is the sole blocker. */
const PARALLEL = [
	STREETS[0],
	{
		osmId: 7,
		name: "Parallel Street",
		subtype: "residential",
		coords: [
			[51.5, -0.13913],
			[51.504, -0.13913],
		] as Array<[number, number]>,
	},
];
const CROSSOVER: PedFix[] = [
	f(1000, 51.5, -0.14),
	f(1060, 51.5004, -0.14),
	f(1120, 51.5008, -0.14),
	f(1180, 51.5012, -0.14),
	f(1240, 51.5016, -0.14),
	f(1300, 51.502, -0.14),
	f(1360, 51.5022, -0.13913),
	f(1420, 51.5026, -0.13913),
];
prepOf("CROSSOVER", CROSSOVER);
{
	const rf = CROSSOVER.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts }));
	const d = MMC.matchImprovesDisplay(rf, F_COARSE, { ways: PARALLEL }, 18, 40);
	console.log(`    crossover use=${d.use} rawOff=${d.rawOffRoadM} matchedOff=${d.matchedOffRoadM} stray=${d.strayM}`);
	const sp = MMC.spliceMatchedWithDivergentRuns(rf, F_COARSE, 40);
	console.log(`    crossover splice ${sp === null ? "null" : `n=${sp.length}`}`);
	if (sp !== null) for (const p of sp) console.log(`      crossover spliced ${p.lat},${p.lon}@${p.ts}`);
}

/** A 778 m walk: long enough that the swap's FRACTION bar can block while its
 *  absolute drop bar passes (the two only separate above ~600 m). */
import * as A from "../../src/geo/pedestrian-match-annotate.js";
import * as EG from "../../src/geo/episode-geometry.js";
import * as PM from "../../src/geo/pedestrian-match.js";
import * as MMC from "../../src/geo/map-match-core.js";
import * as WSM from "../../src/geo/walk-smooth-map.js";
import * as WBE from "../../src/geo/walk-building-escape.js";
import type { TransportMode } from "../../src/geo/segments.js";
const LONGWALK: PedFix[] = [
	f(1000, 51.5, -0.14),
	f(1100, 51.50175, -0.14),
	f(1200, 51.5035, -0.14),
	f(1300, 51.50525, -0.14),
	f(1400, 51.507, -0.14),
];
prepOf("LONGWALK", LONGWALK);
console.log(`    LONGWALK raw len = ${pathLenM(LONGWALK)}`);
console.log(`    WALKING raw len = ${pathLenM(WALKING)}`);
