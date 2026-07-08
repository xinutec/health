import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type HsmmCapturedDay, hsmmInputsFromFixture } from "../src/cli/hsmm-fixture.js";
import { parseGroundTruth } from "../src/eval/ground-truth.js";
import { type DecoderMinute, scoreDay } from "../src/eval/score-day.js";
import { decodeHsmm } from "../src/hmm/decode.js";
import type { HmmSegment } from "../src/hmm/persist.js";

/**
 * Real-data acceptance for the Phase 1 train-generator soft prior
 * (`docs/proposals/decoder-roadmap.md`).
 *
 * Replays the captured 2026-05-22 fixture through the *real* `decodeHsmm`
 * (the code path the prior was wired into) with NO database, then scores
 * the decode's line attribution against the user-confirmed ground-truth
 * narrative. The acceptance bar is the design's: the **line score rises
 * from 0/6** — before the prior, the decoder put a structurally-impossible
 * line on the underground minutes; the prior must pick a valid one.
 *
 * The fixture + ground-truth are gitignored (real coordinates / biometrics),
 * so this test SKIPS when the corpus is absent (CI), mirroring how
 * `golden-check-hsmm` exits 2 with no corpus. It is a local guard.
 */

const DAY = "2026-05-22";
const FIXTURE = path.join(process.cwd(), "tests", "golden", "decoded_days", `${DAY}-pippijn.json`);
const GROUND_TRUTH = path.join(process.cwd(), "tests", "golden", "ground-truth", `${DAY}.md`);

/** Expand decode segments into the per-minute `DecoderMinute[]` the scorer
 *  consumes (one row per top-of-minute, [startTs, endTs)). */
function segmentsToMinutes(segs: readonly HmmSegment[]): DecoderMinute[] {
	const minutes: DecoderMinute[] = [];
	for (const s of segs) {
		for (let t = s.startTs; t < s.endTs; t += 60) {
			minutes.push({ ts: t, mode: s.mode, placeId: s.placeId, lineName: s.lineName });
		}
	}
	return minutes;
}

const hasCorpus = existsSync(FIXTURE) && existsSync(GROUND_TRUTH);

describe.runIf(hasCorpus)("Phase 1 train-generator prior — 2026-05-22 real-data line score", () => {
	// The fixtures are gitignored, so they're absent in CI. Read them inside
	// `beforeAll` (NOT at the describe-callback top level): a skipped suite
	// still EXECUTES its callback during collection but never runs its hooks,
	// so a top-level `readFileSync` would ENOENT in CI even with `runIf` false.
	let score: ReturnType<typeof scoreDay>;
	beforeAll(() => {
		const captured = JSON.parse(readFileSync(FIXTURE, "utf8")) as HsmmCapturedDay;
		const gt = parseGroundTruth(readFileSync(GROUND_TRUTH, "utf8"), DAY, captured.meta.tz);
		const minutes = segmentsToMinutes(decodeHsmm(hsmmInputsFromFixture(captured)));
		// Line scoring is independent of place resolution, so an empty
		// placeName→id map is fine — we only assert on line counts.
		score = scoreDay(gt.rows, minutes, new Map());
		// A full real `decodeHsmm` runs several seconds and slows further
		// under full-suite parallel load — past Vitest's 10 s default hook
		// timeout. Give the decode room so the suite is deterministic
		// (~13 s standalone as of 2026-07 but measured 32 s inside a full
		// parallel run — the old 30 s cap had no headroom left).
	}, 120_000);

	it("has train minutes to score a line against (ground truth + decoder agree on train)", () => {
		expect(score.lineScorable).toBeGreaterThan(0);
	});

	it("attributes the correct line on the underground minutes (was 0)", () => {
		expect(score.lineMatching).toBeGreaterThan(0);
	});
});
