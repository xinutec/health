/**
 * CLI: Lean-shadow A/B — the verified decoder on real captured days.
 *
 * Phase V2 of `docs/proposals/2026-07-verified-core-lean.md`: for each
 * fixture under tests/golden/decoded_days/, build the day's decode model
 * with `buildHsmmModel` (the exact model the production decode runs) and
 * run the shared shadow core (`src/hmm/lean-shadow-core.ts`): quantise to
 * integer tensors, decode with BOTH the TS trellis and the verified Lean
 * decoder, demand exact agreement, and measure quantisation fidelity
 * against the float decode.
 *
 * `--c4-flags` forces the decode-recent cron's C4 mechanism set
 * (chain context / segment evidence / cadence imputation /
 * reacquire-robust speed) onto every fixture regardless of what was
 * captured — exercising the time-varying transition and class-factorised
 * duration export paths the cron shadow needs.
 *
 * Usage: node dist/cli/lean-shadow.js [YYYY-MM-DD] [--c4-flags]
 * Exit 0 = every day's Lean↔TS-quantised decode agrees exactly.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildHsmmModel } from "../hmm/decode.js";
import { shadowHsmmDay } from "../hmm/lean-shadow-core.js";
import { type HsmmCapturedDay, hsmmInputsFromFixture } from "./hsmm-fixture.js";

const DECODED_DIR = path.join(process.cwd(), "tests", "golden", "decoded_days");
const LEAN_BIN = process.env.LEAN_CLI ?? path.join(process.cwd(), "lean", ".lake", "build", "bin", "verified_cli");

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const onlyDate = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? null;
	const c4 = args.includes("--c4-flags");
	const files = (await readdir(DECODED_DIR)).filter((f) => f.endsWith(".json")).sort();
	let failures = 0;
	let checked = 0;
	for (const file of files) {
		const captured = JSON.parse(await readFile(path.join(DECODED_DIR, file), "utf8")) as HsmmCapturedDay;
		if (onlyDate !== null && captured.meta.date !== onlyDate) continue;
		checked++;
		const inputs = hsmmInputsFromFixture(captured);
		if (c4) {
			inputs.chainContext = true;
			inputs.segmentEvidence = true;
			inputs.imputeCadence = true;
			inputs.reacquireRobustSpeed = true;
		}
		const model = buildHsmmModel(inputs);
		try {
			const r = shadowHsmmDay(model, LEAN_BIN);
			if (!r.exact) failures++;
			console.log(
				`${captured.meta.date}  lean↔tsQuant: ${r.verdict.padEnd(16)} ` +
					`float↔quant: ${r.agreeMinutes}/${r.totalMinutes} minutes (${((100 * r.agreeMinutes) / r.totalMinutes).toFixed(2)}%), ` +
					`scoreΔ ${r.scoreDelta.toExponential(2)}  ` +
					`[${r.shape} quantise ${r.quantiseMs.toFixed(0)}ms, ts ${r.tsMs.toFixed(0)}ms, lean ${r.leanMs.toFixed(0)}ms]`,
			);
		} catch (err) {
			failures++;
			console.log(`${captured.meta.date}  SHADOW ERROR: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (checked === 0) {
		console.error("no fixtures matched");
		process.exit(2);
	}
	console.log(failures === 0 ? "\nSHADOW OK — verified decoder exact on all days" : `\n${failures} day(s) MISMATCHED`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
