#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for the `place-override.ts` pure decision leaves
 * being ported to `Verified/Geo/PlaceOverride.lean`.
 * Run: npx tsx lean/experiments/place-override-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const PO = await import(path.join(repo, "src/hmm/place-override.ts"));

// decideHsmmTrainOverride (exported)
const dcases = [
	{ avgSpeedKmh: 25, lineOverlapFraction: 0.9, roadCorridorFraction: 0.2 }, // fires
	{ avgSpeedKmh: 5, lineOverlapFraction: 0.9, roadCorridorFraction: 0.2 }, // too slow
	{ avgSpeedKmh: 25, lineOverlapFraction: 0.0, roadCorridorFraction: null }, // no line
	{ avgSpeedKmh: 25, lineOverlapFraction: 0.3, roadCorridorFraction: 0.8 }, // road-hugging taxi
	{ avgSpeedKmh: 25, lineOverlapFraction: 0.5, roadCorridorFraction: null }, // null road -> 0 -> fires
	{ avgSpeedKmh: 25, lineOverlapFraction: 0.4, roadCorridorFraction: 0.4 }, // equal -> not strictly greater
];
for (const c of dcases) console.log("decide", JSON.stringify(c), "->", PO.decideHsmmTrainOverride(c));

// findDominantTrainLineName / findDominantStationaryPlaceId are module-private;
// faithful reimplementations (verbatim from source) for reference values.
type Hmm = { startTs: number; endTs: number; mode: string; lineName?: string | null; placeId?: number | null };
function dominantTrain(segStart: number, segEnd: number, hmm: Hmm[]) {
	const counts = new Map<string, number>();
	for (const h of hmm) {
		if (h.endTs <= segStart) continue;
		if (h.startTs >= segEnd) break;
		if (h.mode !== "train") continue;
		if (h.lineName === null || h.lineName === undefined || h.lineName === "unknown_rail") continue;
		const overlap = Math.min(segEnd, h.endTs) - Math.max(segStart, h.startTs);
		if (overlap <= 0) continue;
		counts.set(h.lineName, (counts.get(h.lineName) ?? 0) + overlap);
	}
	let bestLine: string | null = null;
	let bestOverlap = 0;
	for (const [line, n] of counts) if (n > bestOverlap) { bestLine = line; bestOverlap = n; }
	if (bestLine === null) return null;
	return { line: bestLine, overlapFraction: bestOverlap / Math.max(1, segEnd - segStart) };
}
function dominantPlace(segStart: number, segEnd: number, hmm: Hmm[]) {
	const counts = new Map<number, number>();
	for (const h of hmm) {
		if (h.endTs <= segStart) continue;
		if (h.startTs >= segEnd) break;
		if (h.mode !== "stationary") continue;
		if (h.placeId === null || h.placeId === undefined) continue;
		const overlap = Math.min(segEnd, h.endTs) - Math.max(segStart, h.startTs);
		if (overlap <= 0) continue;
		counts.set(h.placeId, (counts.get(h.placeId) ?? 0) + overlap);
	}
	let bestId: number | null = null;
	let bestOverlap = 0;
	for (const [id, n] of counts) if (n > bestOverlap) { bestId = id; bestOverlap = n; }
	return bestId;
}

const trainHmm: Hmm[] = [
	{ startTs: 0, endTs: 100, mode: "train", lineName: "Victoria" },
	{ startTs: 100, endTs: 300, mode: "train", lineName: "Northern" },
	{ startTs: 300, endTs: 400, mode: "train", lineName: "unknown_rail" }, // skipped
	{ startTs: 400, endTs: 500, mode: "walking" }, // skipped
];
console.log("dominantTrain 0..600:", JSON.stringify(dominantTrain(0, 600, trainHmm)));
console.log("dominantTrain 0..150:", JSON.stringify(dominantTrain(0, 150, trainHmm))); // Victoria 100 vs Northern 50
console.log("dominantTrain none:", JSON.stringify(dominantTrain(1000, 2000, trainHmm)));

const placeHmm: Hmm[] = [
	{ startTs: 0, endTs: 100, mode: "stationary", placeId: 7 },
	{ startTs: 100, endTs: 400, mode: "stationary", placeId: 9 },
	{ startTs: 400, endTs: 500, mode: "stationary", placeId: null }, // off-network skipped
	{ startTs: 500, endTs: 600, mode: "walking", placeId: 3 }, // skipped
];
console.log("dominantPlace 0..600:", JSON.stringify(dominantPlace(0, 600, placeHmm))); // 9 (300s) > 7 (100s)
console.log("dominantPlace 0..150:", JSON.stringify(dominantPlace(0, 150, placeHmm))); // 7 (100) vs 9 (50) -> 7
console.log("dominantPlace none:", JSON.stringify(dominantPlace(1000, 2000, placeHmm)));

// doorstep gate distance (haversine) — matches src/geo/place-snap haversineMeters
const PS = await import(path.join(repo, "src/geo/place-snap.js"));
console.log("doorstep dist near:", PS.haversineMeters(51.5, -0.1, 51.5009, -0.1)); // ~100 m < 1500 -> allowed
console.log("doorstep dist far:", PS.haversineMeters(51.5, -0.1, 51.52, -0.1)); // ~2224 m > 1500 -> refused
