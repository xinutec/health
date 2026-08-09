/**
 * What the round-loop EXPERIMENTS need beyond the loop itself.
 *
 * The loop moved to `src/lean/day-serve.ts` when it stopped being an experiment
 * — it is the mechanism a `LEAN_DAY` tenant runs (#431 gap 1), and a serving
 * path cannot import out of `lean/experiments/`. What is left here is the one
 * thing that is genuinely measurement: a count taken against a FIXTURE, which
 * production has no equivalent of and no reason to want.
 */

import type { CapturedDay } from "../../src/cli/fixture-day.js";
import type { FoldCaptureFile } from "../../src/lean/fold-capture.js";

/** How many lookups the TS arm made, for the over-fetch comparison. */
export function recordedLookups(cap: FoldCaptureFile, captured: CapturedDay): number {
	return (
		cap.tzAt.length +
		cap.bestPlace.length +
		Object.values(captured.inputs.osmTrace).reduce((n, s) => n + Object.keys(s ?? {}).length, 0)
	);
}
