/**
 * CLI: HSMM decode-replay regression check (deterministic).
 *
 * Replays each captured fixture under tests/golden/decoded_days/ — one
 * real prod day's `HsmmInputs` (filtered points, biometrics, focus
 * places, place-near-line, the raw OSM rows the route graph is built
 * from, the prior-day continuity context, and the per-fix rail/road
 * proximity) — through the pure `decodeHsmm` and diffs the resulting
 * segments against the fixture's blessed `expected` decode.
 *
 * No DB. No network. No port-forward. This is the real-data guard the
 * road-aware line-proximity fix (#238) needs: a future change that
 * resurrects the phantom `train @ Circle Line` on the 05-25 taxi — or
 * that strips the real Met / Circle lines off the 05-22 underground day —
 * surfaces here as a decode diff instead of shipping silently.
 *
 * The corpus is local-only and gitignored (real coordinates / place
 * names / biometrics). Capture a day with capture-hsmm-day.js against
 * prod, then:
 *
 *   npm run golden-hsmm                 # check every captured day
 *   npm run golden-hsmm -- --bless      # re-derive every expected decode
 *   npm run golden-hsmm -- --bless 2026-05-25
 *
 * Exit 0 = every fixture matches (or was blessed).
 * Exit 1 = at least one regressed.
 * Exit 2 = no corpus.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeHsmm } from "../hmm/decode.js";
import type { HmmSegment } from "../hmm/persist.js";
import {
	decodeFlagsFor,
	HSMM_FIXTURE_FORMAT_VERSION,
	type HsmmCapturedDay,
	hsmmInputsFromFixture,
} from "./hsmm-fixture.js";

const DECODED_DIR = path.join(process.cwd(), "tests", "golden", "decoded_days");

function trainLines(segs: readonly HmmSegment[]): string {
	const lines = segs.filter((s) => s.mode === "train").map((s) => s.lineName ?? "unknown_rail");
	return lines.length === 0 ? "(no train)" : lines.join(", ");
}

/** First differing segment between two decodes, or null when identical. */
function firstDiff(a: readonly HmmSegment[], b: readonly HmmSegment[]): string | null {
	const n = Math.max(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const x = a[i];
		const y = b[i];
		const xs = x ? `${x.mode}@${x.lineName ?? x.placeId ?? "-"} ${x.startTs}-${x.endTs}` : "(none)";
		const ys = y ? `${y.mode}@${y.lineName ?? y.placeId ?? "-"} ${y.startTs}-${y.endTs}` : "(none)";
		if (xs !== ys) return `seg[${i}]: expected ${xs} · got ${ys}`;
	}
	return null;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const bless = args.includes("--bless");
	const onlyDate = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? null;

	let files: string[];
	try {
		files = (await readdir(DECODED_DIR)).filter((f) => f.endsWith(".json")).sort();
	} catch {
		console.error(`no corpus at ${DECODED_DIR} — capture one with capture-hsmm-day.js`);
		process.exit(2);
	}
	if (files.length === 0) {
		console.error(`no fixtures in ${DECODED_DIR}`);
		process.exit(2);
	}

	let failures = 0;
	let checked = 0;
	for (const file of files) {
		const captured = JSON.parse(await readFile(path.join(DECODED_DIR, file), "utf8")) as HsmmCapturedDay;
		if (onlyDate !== null && captured.meta.date !== onlyDate) continue;
		checked++;

		const inputs = hsmmInputsFromFixture(captured);
		const decode = decodeHsmm(inputs);
		// Which C4 configuration this day replayed under. A v1 fixture recorded
		// none, so it is being replayed under production's — say so per day
		// rather than let the assumption hide, because an unrecorded
		// configuration is exactly what split this corpus in two.
		const cfg = decodeFlagsFor(captured);
		const cfgNote = cfg.recorded
			? ""
			: "  [v1 fixture: no recorded flags, replayed under production defaults — re-bless to pin]";

		if (bless) {
			captured.expected = decode;
			captured.meta.fixtureFormatVersion = HSMM_FIXTURE_FORMAT_VERSION;
			captured.inputs.decodeFlags = cfg.flags;
			await writeFile(path.join(DECODED_DIR, file), `${JSON.stringify(captured, null, "\t")}\n`, "utf8");
			console.log(`BLESSED  ${captured.meta.date} ${captured.meta.user} — train: ${trainLines(decode)}`);
			continue;
		}

		const diff = firstDiff(captured.expected, decode);
		if (diff === null) {
			console.log(`PASS     ${captured.meta.date} ${captured.meta.user} — train: ${trainLines(decode)}${cfgNote}`);
		} else {
			failures++;
			console.log(`FAIL     ${captured.meta.date} ${captured.meta.user}${cfgNote}`);
			console.log(`    ${diff}`);
			console.log(`    expected train: ${trainLines(captured.expected)}`);
			console.log(`    got      train: ${trainLines(decode)}`);
		}
	}

	if (checked === 0) {
		console.error(onlyDate ? `no fixture for ${onlyDate}` : "no fixtures matched");
		process.exit(2);
	}
	if (bless) {
		console.log(`\nBlessed ${checked} fixture(s).`);
		process.exit(0);
	}
	console.log(`\n${checked - failures}/${checked} HSMM fixture(s) match baseline.`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
