#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `absorbBoardingPlatform`
 * (`src/geo/passes/rail-absorbers.ts`), ported into
 * `Verified/Geo/RailAbsorbers.lean`.
 *
 * The other three exports of that file are already ported and pinned; this is
 * the one whose station lookup made it look like shell. The lookup is an
 * INJECTED function, so it ports with the lookup as a parameter.
 *
 * The stub records the coordinate it was asked about and answers a station only
 * there, so the point-averaged centroid is pinned by which query succeeds
 * rather than asserted. The queried coordinates are printed at full precision
 * for transcription into the Lean stub.
 *
 * Run: npx tsx lean/experiments/absorb-boarding-platform-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EnrichedSegment } from "../../src/geo/enriched-segment.js";

const here = path.dirname(fileURLToPath(import.meta.url));

type Fix = { ts: number; lat: number; lon: number; speed_kmh: number; bearing: number };
type Seg = Record<string, unknown>;

const fix = (ts: number, lat: number, lon: number): Fix => ({ ts, lat, lon, speed_kmh: 0, bearing: 0 });

const MET = "Euston Square → Baker Street · Metropolitan Line";

/** The platform cluster: four fixes whose mean is NOT any one of them, so the
 *  average is observable. The last sits exactly ON the stationary's closing
 *  boundary — excluded by the exclusive-end window, which is what separates it
 *  from `samplesInWindow`. */
const platform: Fix[] = [
	fix(600, 51.5254, -0.1359),
	fix(660, 51.5256, -0.1361),
	fix(720, 51.5252, -0.1357),
	fix(900, 51.9999, -0.9999),
];

const asked: string[] = [];

/** Answers "Euston Square" only at the platform centroid, "Baker Street" only
 *  at the decoy, nothing anywhere else. */
import * as A from "../../src/geo/passes/rail-absorbers.js";
const lookup = async (lat: number, lon: number) => {
	asked.push(`${lat},${lon}`);
	// The platform: an entrance CODE nearer than the station itself, so the
	// ranking inside pickBestStation is exercised rather than assumed.
	if (lat === 51.52539999999999 && lon === -0.1359)
		return [
			{ name: "B2", subtype: "station", distanceM: 5 },
			{ name: "Euston Square", subtype: "station", distanceM: 20 },
		];
	if (lat === 51.5271 && lon === -0.1327) return [{ name: "King's Cross St Pancras", subtype: "station", distanceM: 30 }];
	if (lat === 51.9999 && lon === -0.9999) return [{ name: "Baker Street", subtype: "station", distanceM: 20 }];
	// A station with an EMPTY name: the only thing that could tell a rejected
	// missing label apart from one parsed as an empty boarding station.
	if (lat === 40 && lon === 40) return [{ name: "", subtype: "station", distanceM: 20 }];
	// A station at the NaN centroid an empty window would produce. Reached only
	// if the empty-window guard is gone.
	if (Number.isNaN(lat)) return [{ name: "Euston Square", subtype: "station", distanceM: 20 }];
	return [];
};

const stay = (startTs: number, endTs: number, over: Seg = {}): Seg => ({
	startTs,
	endTs,
	mode: "stationary",
	pointCount: 4,
	...over,
});
const train = (startTs: number, endTs: number, over: Seg = {}): Seg => ({
	startTs,
	endTs,
	mode: "train",
	wayName: MET,
	pointCount: 30,
	...over,
});

const show = async (label: string, segs: Seg[], points: Fix[] = platform) => {
	asked.length = 0;
	// The fixtures are deliberately PARTIAL — they carry only the fields this
	// pass reads, which is what the guards pin. One documented conversion at the
	// boundary is honest about that; `as never` on every argument was not, and it
	// also broke the `out === input` identity check below by erasing the link
	// between the array going in and the one coming out (#418).
	const input = segs as unknown as EnrichedSegment[];
	const out = await A.absorbBoardingPlatform(input, points, lookup);
	const cells = out.map((s) => `${s.mode}[${s.startTs},${s.endTs}]`);
	console.log(`${label.padEnd(44)} ${cells.join(" ")}${out === input ? "  (same array)" : ""}`);
	for (const a of asked) console.log(`${"".padEnd(44)}   asked: ${a}`);
};

console.log("=== absorbBoardingPlatform ===");
await show("platform wait before the train it boards", [stay(600, 900), train(900, 1800)]);
await show("station is not the boarding station", [stay(600, 900), train(900, 1800, { wayName: "Baker Street → Wembley Park · Metropolitan Line" })]);
await show("lookup finds nothing", [stay(600, 900), train(900, 1800)], [fix(600, 0, 0), fix(660, 0, 0)]);

console.log("--- what disqualifies the pair ---");
await show("no arrow in the wayName", [stay(600, 900), train(900, 1800, { wayName: "Metropolitan Line" })]);
await show("wayName absent", [stay(600, 900), train(900, 1800, { wayName: undefined })]);
await show("previous is not stationary", [stay(600, 900, { mode: "walking" }), train(900, 1800)]);
await show("train at index 0 has no previous", [train(900, 1800)]);
// An empty window averages 0/0 = NaN. The station lookup answers at NaN, so if
// the guard were gone the pass would absorb off a query it should never make.
await show("no fixes inside — NaN is never asked", [stay(600, 900), train(900, 1800)], [fix(1000, 51.5254, -0.1359)]);
// A missing label is REJECTED, not read as an empty boarding station: the
// station here IS named "", and the wait still survives.
await show("missing label vs a station named ''", [stay(600, 900), train(900, 1800, { wayName: undefined })], [fix(700, 40, 40)]);
await show("…and an empty board does absorb there", [stay(600, 900), train(900, 1800, { wayName: " → Baker Street" })], [fix(700, 40, 40)]);

console.log("--- the 15-minute platform bar ---");
await show("900 s exactly still absorbs", [stay(0, 900), train(900, 1800)]);
await show("901 s is a stay of its own", [stay(-1, 900), train(900, 1800)]);

console.log("--- RAW mode, not effectiveMode (unlike the anchors) ---");
await show("train only by refinedMode", [stay(600, 900), train(900, 1800, { mode: "driving", refinedMode: "train" })]);
await show("stationary only by refinedMode", [stay(600, 900, { mode: "walking", refinedMode: "stationary" }), train(900, 1800)]);

console.log("--- the window is EXCLUSIVE at the closing end ---");
// The decoy fix sits exactly on 900. Were the window inclusive it would drag
// the centroid to the decoy and the pass would resolve "Baker Street".
await show("boundary fix belongs to the next segment", [stay(600, 900), train(900, 1800)]);
await show("…and the decoy alone resolves Baker St", [stay(600, 901), train(901, 1800, { wayName: "Baker Street → Wembley Park" })], [fix(900, 51.9999, -0.9999)]);

console.log("--- shape ---");
await show(
	"a moving segment survives around it",
	[{ startTs: 0, endTs: 600, mode: "walking" }, stay(600, 900), train(900, 1800), { startTs: 1800, endTs: 2400, mode: "walking" }],
);
await show(
	"two platform waits in one day",
	[
		stay(600, 900),
		train(900, 1800),
		stay(1800, 2100),
		train(2100, 3000, { wayName: "King's Cross St Pancras → Farringdon · Circle Line" }),
	],
	[...platform, fix(1800, 51.5271, -0.1327), fix(1900, 51.5271, -0.1327)],
);
await show("nothing to absorb returns the input array", [{ startTs: 0, endTs: 600, mode: "walking" }]);

console.log("--- untouched fields survive; the train keeps everything but startTs ---");
{
	const t = train(900, 1800, { refinedReason: "earlier note", confidence: 0.9, place: "Somewhere" });
	const out = await A.absorbBoardingPlatform([stay(600, 900), t] as unknown as EnrichedSegment[], platform, lookup);
	console.log(JSON.stringify(out));
}
