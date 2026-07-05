#!/usr/bin/env node
/**
 * Scan a date range for days where bridgeStaysWithBiometrics WOULD
 * have merged something. Lets us answer "does anyone actually need
 * this behaviour, or is the bridge dead code".
 *
 * For each date in the range:
 *   - Call computeVelocity (full pipeline, including the bridge —
 *     so a merge that DID fire shows zero candidates here; that's
 *     fine, those are exactly the cases the bridge no-ops on).
 *   - Look at adjacent stationary segments and check if their
 *     centroids are within 150 m, the gap < 10 min, and the gap
 *     window has HR (≥3 samples, mean ≤ 90 bpm) and zero steps.
 *
 * Prints each candidate. Date range is process.argv[2..3] or a
 * sensible default (last 30 days).
 *
 * Usage:
 *   scripts/prod-db.sh node scripts/find-bridge-candidates.mjs \
 *     [from_iso] [to_iso]
 */

import { execSync } from "node:child_process";

const from = process.argv[2] ?? "2026-05-01";
const to = process.argv[3] ?? "2026-06-01";

function* iterDates(fromIso, toIso) {
	let d = new Date(fromIso + "T00:00:00Z");
	const end = new Date(toIso + "T00:00:00Z");
	while (d < end) {
		yield d.toISOString().slice(0, 10);
		d = new Date(d.getTime() + 24 * 3600 * 1000);
	}
}

const PIPE_OUT = (cmd) => execSync(cmd, { encoding: "utf8" });

let totalCandidates = 0;
const COLOCATION_M = 150;
const MAX_GAP_SEC = 10 * 60;

function haversineMeters(lat1, lon1, lat2, lon2) {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

for (const date of iterDates(from, to)) {
	let output;
	try {
		output = PIPE_OUT(`node dist/cli/analyze-day.js ${date} pippijn Europe/London 2>&1`);
	} catch (e) {
		console.error(`# ${date}: analyze-day failed`);
		continue;
	}
	// Parse the analyze-day "Segments" section.
	const segMatch = output.match(/=== Segments[^=]+===\s+([\s\S]+?)(?=\s+===)/);
	if (segMatch === null) continue;
	const segLines = segMatch[1]
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => /^\d{2}:\d{2}-\d{2}:\d{2}/.test(l));
	// Look for any two consecutive stationary segments — place labels
	// may differ (one might be unlabelled). Report with a generous
	// 30-min gap ceiling so the human can eyeball candidates.
	function parseLine(line) {
		const m = line.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2}).*?(stationary|walking|train|driving|cycling)/);
		if (!m) return null;
		return {
			startMin: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
			endMin: parseInt(m[3], 10) * 60 + parseInt(m[4], 10),
			mode: m[5],
			text: line.slice(0, 16),
			placeMatch: line.match(/@ ([^\[(]+?)\s*(?:\(|\[|$)/),
		};
	}
	const parsed = segLines.map(parseLine).filter((p) => p !== null);
	for (let i = 0; i + 1 < parsed.length; i++) {
		const cur = parsed[i];
		const next = parsed[i + 1];
		if (cur.mode !== "stationary" || next.mode !== "stationary") continue;
		const gapMin = next.startMin - cur.endMin;
		if (gapMin < 0 || gapMin > 30) continue;
		const curPlace = cur.placeMatch?.[1]?.trim() ?? "(unlabelled)";
		const nextPlace = next.placeMatch?.[1]?.trim() ?? "(unlabelled)";
		console.log(`${date}  ${cur.text} → ${next.text}  gap=${gapMin}m  ${curPlace} | ${nextPlace}`);
		totalCandidates++;
	}
}

console.log(`\n=== ${totalCandidates} candidate(s) across ${from} → ${to} ===`);
