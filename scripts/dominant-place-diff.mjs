#!/usr/bin/env node
// For each day, report dominant stationary placeId in flag_off vs flag_on
// (dominant = placeId that appears in the most minutes).
import { readFileSync } from "node:fs";

const a = JSON.parse(readFileSync(process.argv[2], "utf8"));
const b = JSON.parse(readFileSync(process.argv[3], "utf8"));

function dominant(segs) {
	const counts = new Map();
	for (const s of segs) {
		if (s.mode !== "stationary" || s.placeId === null) continue;
		const mins = Math.round((s.endTs - s.startTs) / 60);
		counts.set(s.placeId, (counts.get(s.placeId) ?? 0) + mins);
	}
	let bestId = null;
	let bestMin = 0;
	for (const [id, mins] of counts) {
		if (mins > bestMin) {
			bestMin = mins;
			bestId = id;
		}
	}
	return { id: bestId, mins: bestMin };
}

const dates = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
console.log(`# date         off_dom (min)   on_dom (min)   flip?`);
for (const date of dates) {
	const da = dominant(a[date] ?? []);
	const db = dominant(b[date] ?? []);
	const flip = da.id !== db.id ? "YES" : "";
	console.log(
		`  ${date}   ${String(da.id ?? "-").padEnd(6)} (${String(da.mins).padStart(4)})   ${String(db.id ?? "-").padEnd(6)} (${String(db.mins).padStart(4)})   ${flip}`,
	);
}
process.exit(0);
