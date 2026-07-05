#!/usr/bin/env node
// Compare two dumps from scripts/dump-all-segments.mjs.
// For each date, report whether the segments differ; for differing
// days report a per-minute place-id delta + segment-count delta.
import { readFileSync } from "node:fs";

const [aPath, bPath, aLabel = "A", bLabel = "B"] = process.argv.slice(2);
if (!aPath || !bPath) {
	console.error("usage: diff-segments.mjs <a.json> <b.json> [aLabel bLabel]");
	process.exit(2);
}

const a = JSON.parse(readFileSync(aPath, "utf8"));
const b = JSON.parse(readFileSync(bPath, "utf8"));

function expandSegments(segs) {
	// Each segment is { startTs, endTs, mode, placeId, lineName }.
	// Build a per-minute (mode, placeId) array — 1440 entries.
	if (!segs.length) return null;
	const dayStart = Math.floor(segs[0].startTs / 60) * 60;
	const dayEnd = dayStart + 1440 * 60;
	const minutes = [];
	for (const s of segs) {
		const startMin = Math.max(0, Math.floor((s.startTs - dayStart) / 60));
		const endMin = Math.min(1440, Math.ceil((s.endTs - dayStart) / 60));
		for (let m = startMin; m < endMin; m++) {
			minutes[m] = { mode: s.mode, placeId: s.placeId ?? null, lineName: s.lineName ?? null };
		}
	}
	return minutes;
}

const dates = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
let diffCount = 0;
console.log(`# Comparing ${aLabel} vs ${bLabel} across ${dates.length} days`);
console.log(`# date         segs_${aLabel}/${bLabel}   diff_min   first_diff   note`);
for (const date of dates) {
	const segsA = a[date] ?? [];
	const segsB = b[date] ?? [];
	const minsA = expandSegments(segsA);
	const minsB = expandSegments(segsB);
	if (minsA === null && minsB === null) continue;
	let diffMinutes = 0;
	let firstDiff = null;
	const len = Math.max(minsA?.length ?? 0, minsB?.length ?? 0);
	for (let m = 0; m < len; m++) {
		const x = minsA?.[m];
		const y = minsB?.[m];
		if (!x && !y) continue;
		if (!x || !y || x.mode !== y.mode || x.placeId !== y.placeId) {
			if (firstDiff === null) firstDiff = m;
			diffMinutes++;
		}
	}
	const isDiff = diffMinutes > 0 || segsA.length !== segsB.length;
	if (isDiff) {
		diffCount++;
		const fd = firstDiff !== null ? `${String(Math.floor(firstDiff / 60)).padStart(2, "0")}:${String(firstDiff % 60).padStart(2, "0")}` : "-";
		console.log(
			`  ${date}   ${String(segsA.length).padStart(3)}/${String(segsB.length).padEnd(3)}   ${String(diffMinutes).padStart(4)}min   ${fd.padStart(5)}      ${diffMinutes > 60 ? "(material)" : "(minor)"}`,
		);
	}
}
console.log(`# ${diffCount}/${dates.length} days differ`);
process.exit(0);
