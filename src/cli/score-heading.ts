/**
 * CLI: heading-agreement report — PDR Phase 0 (#296/#297), measurement only.
 *
 * Replays a captured golden fixture through the pure pipeline and, per walking
 * episode, compares the phone-reported course over ground (`motion_log.cog`,
 * captured at the Owntracks ingest since 2026-07-01) against two references:
 *
 *   - the raw GPS hop course (fix i → fix i+1 bearing) — is the phone heading
 *     an INDEPENDENT witness that agrees with observed motion?
 *   - the Kalman bearing — does it corroborate the smoothed direction?
 *
 * The verdict this report exists to produce: is `cog` trustworthy enough
 * during walks to serve as the per-fix direction factor the true-path
 * proposal's Pillar 1 needs (out-and-back vs straight — the class steps
 * alone measurably cannot disambiguate)? Zero DB: fixtures captured after
 * the `motionLog` input field carry the rows; older fixtures report
 * "no motion data" honestly.
 *
 *   node dist/cli/score-heading.js              # every fixture with motion data
 *   node dist/cli/score-heading.js 2026-07-01   # one day (pippijn)
 */

import { readdirSync, readFileSync } from "node:fs";
import {
	circularDiffDeg,
	compareHeadings,
	DEFAULT_COMPARE,
	type MotionSample,
	summarizeDiffs,
	type TrackSample,
} from "../eval/heading-eval.js";
import type { MotionFix } from "../geo/classification-inputs.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

function hhmm(ts: number): string {
	return new Date(ts * 1000).toISOString().slice(11, 16);
}

function fmt(v: number | null, digits = 0): string {
	return v === null ? "  -" : v.toFixed(digits).padStart(3);
}

async function scoreDay(date: string, user: string): Promise<boolean> {
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-${user}.json`, "utf8"));
	const inputs = inputsFromFixture(captured);
	const motion: MotionFix[] = inputs.motionLog ?? [];
	if (motion.length === 0) {
		console.log(`${date}: no motion data in fixture (captured pre-motionLog or pre-ingest)`);
		return false;
	}
	const withCog = motion.filter((m) => m.cogDeg !== null).length;
	const moving = motion.filter((m) => m.cogDeg !== null && (m.velKmh ?? 0) >= DEFAULT_COMPARE.minVelKmh).length;
	console.log(
		`${date}: ${motion.length} motion fix(es), ${withCog} with heading (${((100 * withCog) / motion.length).toFixed(0)}%), ${moving} moving-with-heading`,
	);

	const result = await computeVelocityFromInputs(inputs, {});
	const samples: MotionSample[] = motion.map((m) => ({ ts: m.ts, cogDeg: m.cogDeg, velKmh: m.velKmh }));

	for (const ep of result.episodes) {
		if (ep.mode !== "walking" || ep.points.length < 2) continue;
		const raw: TrackSample[] = result.rawFixes
			.filter((f) => f.ts >= ep.startTs && f.ts <= ep.endTs)
			.map((f) => ({ ts: f.ts, lat: f.lat, lon: f.lon }));
		const inWindow = samples.filter((m) => m.ts >= ep.startTs && m.ts <= ep.endTs);

		// cog vs raw GPS hop course.
		const vsRaw = compareHeadings(raw, inWindow);
		const rawSummary = summarizeDiffs(vsRaw.map((c) => c.diffDeg));

		// cog vs the Kalman bearing at the same instant (exact-ts join is fine:
		// the proxy forwards the same fix, so timestamps coincide).
		const kalmanByTs = new Map(result.points.map((p) => [p.ts, p.bearing]));
		const vsKalman: number[] = [];
		for (const m of inWindow) {
			if (m.cogDeg === null || (m.velKmh ?? 0) < DEFAULT_COMPARE.minVelKmh) continue;
			const bearing = kalmanByTs.get(m.ts);
			if (bearing === undefined || bearing === null) continue;
			vsKalman.push(circularDiffDeg(m.cogDeg, bearing));
		}
		const kalmanSummary = summarizeDiffs(vsKalman);

		console.log(
			`  walk @${hhmm(ep.startTs)}Z  motion ${inWindow.length}  ` +
				`cog-vs-rawCourse n=${rawSummary.n} med ${fmt(rawSummary.medianDeg)}° p90 ${fmt(rawSummary.p90Deg)}°  ` +
				`cog-vs-kalman n=${kalmanSummary.n} med ${fmt(kalmanSummary.medianDeg)}° p90 ${fmt(kalmanSummary.p90Deg)}°`,
		);
	}
	return true;
}

async function main(): Promise<void> {
	const user = "pippijn";
	const arg = process.argv[2];
	const dates = arg
		? [arg]
		: readdirSync("tests/golden/days")
				.filter((f) => f.endsWith(`-${user}.json`))
				.map((f) => f.slice(0, 10))
				.sort();

	let any = false;
	for (const date of dates) any = (await scoreDay(date, user)) || any;
	if (!any) {
		console.log("\nNo fixture carries motion data yet — re-capture a day on/after 2026-07-01.");
		process.exit(2);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
