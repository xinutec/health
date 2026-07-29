#!/usr/bin/env node
// WHICH decoder leg is the phantom ride, and which truth rows convict it?
//
// `score-decoder`'s scoreboard reports `phantom rides N` — a count, with no
// way to see the leg. `countPhantomRides` convicts a decoder vehicle leg when
// MORE THAN HALF its duration lies inside enforceable ground-truth rows that
// assert a non-vehicle mode. This prints every decoder vehicle leg with that
// arithmetic shown, so a rise from 0 to 1 can be attributed to a leg rather
// than argued about.
//
// Decodes exactly as score-decoder does: the fixture's own recorded
// `decodeFlags`, no env override. Keep it that way — a probe that measures a
// configuration nobody runs cannot be believed (see the note at
// src/cli/score-decoder-golden.ts:194).
//
// Usage:
//   nix develop . --command node scripts/probe-decoder-phantom.mjs <date>
import { readFileSync } from "node:fs";
import { isEnforceableTruth, parseGroundTruth } from "../dist/eval/ground-truth.js";
import { canonicalMode } from "../dist/eval/score-day.js";
import { decoderJourneys } from "../dist/eval/journey-score.js";
import { decodeHsmm } from "../dist/hmm/decode.js";
import { hsmmInputsFromFixture } from "../dist/cli/hsmm-fixture.js";

const VEHICLE = new Set(["train", "bus", "driving", "cycling", "plane"]);
const date = process.argv[2];
const captured = JSON.parse(readFileSync(`tests/golden/decoded_days/${date}-pippijn.json`, "utf8"));
const gt = parseGroundTruth(readFileSync(`tests/golden/ground-truth/${date}.md`, "utf8"), date, captured.meta.tz);

const segs = decodeHsmm(hsmmInputsFromFixture(captured));
const minutes = [];
for (const s of segs) {
	for (let t = s.startTs; t < s.endTs; t += 60) {
		minutes.push({
			ts: t,
			mode: s.mode,
			placeId: s.placeId,
			lineName: s.lineName,
			board: s.boardStation ?? null,
			alight: s.alightStation ?? null,
		});
	}
}

const t = (ts) => new Date(ts * 1000).toISOString().slice(11, 16);
const contradicting = gt.rows.filter(
	(r) => isEnforceableTruth(r) && r.truth !== null && !VEHICLE.has(canonicalMode(r.truth.mode)),
);

console.log(`\n=== ${date} · decoder vehicle legs vs contradicting truth (UTC) ===`);
for (const j of decoderJourneys(minutes)) {
	for (const leg of j.legs) {
		if (!VEHICLE.has(leg.mode)) continue;
		const dur = leg.endTs - leg.startTs;
		const hits = [];
		let contradictedS = 0;
		for (const r of contradicting) {
			const ov = Math.max(0, Math.min(leg.endTs, r.endTs) - Math.max(leg.startTs, r.startTs));
			if (ov > 0) {
				contradictedS += ov;
				hits.push(`${t(r.startTs)}-${t(r.endTs)} ${r.truth.mode}${r.truth.place ? ` @ ${r.truth.place}` : ""} (${ov}s)`);
			}
		}
		const verdict = contradictedS > dur / 2 ? "PHANTOM" : "ok";
		console.log(
			`\n  ${verdict.padEnd(8)} ${t(leg.startTs)}-${t(leg.endTs)} ${leg.mode}${leg.lineName ? ` · ${leg.lineName}` : ""}` +
				`  [${leg.board ?? "?"}→${leg.alight ?? "?"}]  ${contradictedS}/${dur}s contradicted`,
		);
		for (const h of hits) console.log(`             ${h}`);
	}
}
