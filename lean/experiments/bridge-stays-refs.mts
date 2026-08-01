#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `src/geo/bridge-stays-biometrics.ts`, ported to
 * `Verified/Geo/BridgeStays.lean`.
 *
 * Run: npx tsx lean/experiments/bridge-stays-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const B = await import(path.join(repo, "src/geo/bridge-stays-biometrics.ts"));

const stay = (startTs: number, endTs: number, pointCount = 10) =>
	({
		startTs, endTs, mode: "stationary", confidence: 0.9, confidenceMargin: 2,
		avgSpeed: 0.2, maxSpeed: 1, linearity: 0.1, pointCount,
	}) as never;
const walking = (startTs: number, endTs: number) =>
	({ ...(stay(startTs, endTs, 5) as object), mode: "walking", avgSpeed: 4.5, maxSpeed: 6 }) as never;

const hr = (ts: number, bpm: number) => ({ ts, bpm });
const step = (ts: number, steps: number) => ({ ts, steps });

// Pizza Union: two stays either side of a 5-minute no-fix gap, same table.
const pizza = [stay(0, 1200, 40), stay(1500, 3000, 50)];
const sameSpot = [[51.52, -0.08], [51.52, -0.08]] as never;
const restingHr = [hr(1250, 68), hr(1300, 66), hr(1350, 70), hr(1400, 67)];
const noSteps = [step(1260, 0), step(1320, 0)];

const run = (label: string, segments: unknown[], centroids: unknown, h: unknown[], s: unknown[]) => {
	const out = B.bridgeStaysWithBiometrics({
		segments, centroids, hr: h, steps: s,
	} as never) as { startTs: number; endTs: number; pointCount: number; mode: string }[];
	console.log(`${label}: n=${out.length}`, JSON.stringify(out.map((o) => [o.mode, o.startTs, o.endTs, o.pointCount])));
};

run("merge", pizza, sameSpot, restingHr, noSteps);
run("stepsInGap", pizza, sameSpot, restingHr, [step(1260, 0), step(1320, 12)]);
run("tooFewHr", pizza, sameSpot, [hr(1250, 68), hr(1300, 66)], noSteps);
run("noHr", pizza, sameSpot, [], noSteps);
run("elevatedHr", pizza, sameSpot, [hr(1250, 95), hr(1300, 96), hr(1350, 94)], noSteps);
// Samples exactly ON the gap boundaries must not count — strictly inside only.
run("boundaryHr", pizza, sameSpot, [hr(1200, 60), hr(1300, 60), hr(1500, 60)], noSteps);

run("farApart", pizza, [[51.52, -0.08], [51.5225, -0.08]] as never, restingHr, noSteps);
run("nullCentroid", pizza, [[51.52, -0.08], null] as never, restingHr, noSteps);
run("gapTooLong", [stay(0, 1200), stay(2000, 3000)], sameSpot,
	[hr(1300, 60), hr(1400, 60), hr(1500, 60)], noSteps);

// Back-to-back: no gap, so only the combined-window HR test applies.
const backToBack = [stay(0, 1200, 40), stay(1200, 2400, 50)];
run("b2bNoHr", backToBack, sameSpot, [], []);
run("b2bExercise", backToBack, sameSpot, [hr(600, 140), hr(1800, 140)], []);
run("b2bSedentary", backToBack, sameSpot, [hr(600, 70), hr(1800, 72)], []);

run("walkBreaksRun", [stay(0, 1200, 40), walking(1200, 1500), stay(1500, 3000, 50)],
	[[51.52, -0.08], [51.52, -0.08], [51.52, -0.08]] as never, restingHr, noSteps);
run("empty", [], [] as never, [], []);
run("loneWalk", [walking(0, 600)], [null] as never, [], []);

// Drift: each stay ~110 m from the last, the third ~220 m from the FIRST.
// Co-location is measured from the run's first stay, so the third must not join.
run("drift", [stay(0, 600), stay(600, 1200), stay(1200, 1800)],
	[[51.52, -0.08], [51.521, -0.08], [51.522, -0.08]] as never, [], []);
