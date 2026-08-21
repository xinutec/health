#!/usr/bin/env -S npx tsx
/**
 * The TypeScript answer for the head's battery trace, over the golden corpus.
 *
 * The fixtures freeze `inputs` and the TS arm's capture, but the capture has no
 * battery series — `computeVelocity` builds the chart BESIDE the fold rather
 * than inside it, so nothing in the day request carries it. The Rust port of
 * the head (#982) therefore has no oracle in the file, and this writes one.
 *
 * ⚠ THIS IS THE ORACLE, NOT A COMPARATOR. It runs the production TypeScript and
 * records what it says; `rust/backend/tests/head_corpus.rs` is what compares.
 * Splitting them that way keeps the Rust test able to run with no Node, the way
 * every other test in that file already does — it skips, loudly, when the
 * oracle is absent.
 *
 * Run: npx tsx lean/experiments/battery-oracle.mts   (writes $BATTERY_ORACLE,
 * default /tmp/battery-ts.json)
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dateBoundsUtc } from "../../src/geo/timezone.js";
import { appendBatteryTail, batterySeries } from "../../src/geo/velocity.js";

const dir = "tests/golden/days";
const out: Record<string, Array<[number, number]>> = {};
for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
	const fx = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
	const b = dateBoundsUtc(f.slice(0, 10), fx.inputs.identity?.displayTz);
	// The in-day window, BEFORE the quality and accuracy filters — a fix dropped
	// for an incoherent position still reported a real battery level.
	const inDay = fx.inputs.phonetrack.today.filter((p: { ts: number }) => p.ts >= b.startUtc && p.ts < b.endUtc);
	const series = appendBatteryTail(batterySeries(inDay), fx.inputs.batteryTail, b.endUtc);
	out[f] = series.map((s) => [s.ts, s.level] as [number, number]);
}
const dest = process.env.BATTERY_ORACLE ?? "/tmp/battery-ts.json";
writeFileSync(dest, JSON.stringify(out));
console.log(`${Object.keys(out).length} days -> ${dest}`);
