/**
 * The `--bless-*` flags are the ratchets' only interface, and until #442 each
 * one ended in its own `process.exit(0)`: `--bless-truth --bless-feasibility`
 * ran the feasibility block, wrote its baseline and exited, leaving the truth
 * floor untouched with no warning and exit 0.
 *
 * That is the direction that costs something. A run blessing several ratchets
 * after a big fix reports success while the gate quietly holds the old floor,
 * so the next unrelated change reads as a regression against a floor that was
 * never raised — which is how a locked-in gain fails to be locked in.
 *
 * These tests drive the built CLI against a SCRATCH corpus, because the defect
 * lives in the CLI's control flow and not in any helper: `ratchetUpFloor` and
 * `ratchetDownCounts` were always correct, they simply were not called. The
 * corpus is one empty day with no ground-truth narrative — enough to make the
 * run reach every bless block, and it touches nothing under `tests/golden/`.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_FORMAT_VERSION } from "../src/cli/fixture-day.js";
import { emptyOsmTrace } from "../src/geo/osm-adapter-recording.js";

const run = promisify(execFile);
const CLI = path.join(process.cwd(), "dist", "cli", "golden-check.js");
const DATE = "2026-05-15";

/** An empty day: the input closure is complete and the run reaches no OSM call
 *  site, so the replay is deterministic and needs neither DB nor network. */
function emptyDay() {
	return {
		meta: {
			fixtureFormatVersion: FIXTURE_FORMAT_VERSION,
			capturedAt: "2026-05-15T00:00:00.000Z",
			capturedAtCodeSha: "deadbeef",
			date: DATE,
			user: "pippijn",
			tz: "Europe/London",
			description: "bless-flag scratch corpus",
		},
		inputs: {
			identity: { userId: "pippijn", date: DATE, displayTz: "Europe/London" },
			phonetrack: { today: [], morning: [], priorEvening: [] },
			knownPlaces: [],
			biometrics: { hr: [], sleep: [], steps: [] },
			modeBiometrics: [],
			hsmmDecode: null,
			railRouteCache: [],
			homeTz: "Europe/Amsterdam",
			sleepWindows: [],
			emptyDayBracket: null,
			osmTrace: emptyOsmTrace(),
		},
		expected: { velocity: [] },
	};
}

let scratch: string | null = null;

/** `GOLDEN_DIR` is resolved from `process.cwd()`, which is what lets the CLI be
 *  pointed at a corpus of our own. Baselines are seeded COMPACT so that "the
 *  file was rewritten" is decidable from its bytes: every bless writes
 *  tab-indented JSON with a trailing newline. */
async function seed(baselines: Record<string, unknown>): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "golden-bless-"));
	scratch = dir;
	const golden = path.join(dir, "tests", "golden");
	await mkdir(path.join(golden, "days"), { recursive: true });
	await writeFile(path.join(golden, "days", `${DATE}.json`), `${JSON.stringify(emptyDay(), null, "\t")}\n`, "utf8");
	for (const [name, value] of Object.entries(baselines)) {
		await writeFile(path.join(golden, name), JSON.stringify(value), "utf8");
	}
	return dir;
}

afterEach(async () => {
	if (scratch) await rm(scratch, { recursive: true, force: true });
	scratch = null;
});

describe("golden-check --bless-* flags", () => {
	it("applies every requested ratchet in one run, not just the first", async () => {
		const dir = await seed({
			// Measured this run with zero violations, so the ceiling ratchets 3 -> 0
			// and the day drops out entirely: a semantic move, not just a rewrite.
			"feasibility-baseline.json": { [DATE]: 3 },
			// No narrative for this day, so the floor is not measured and passes
			// through unchanged — the rewrite is what proves the block ran at all.
			"truth-baseline.json": { [DATE]: [1700000000] },
		});

		const { stdout } = await run("node", [CLI, "--bless-truth", "--bless-feasibility"], { cwd: dir });

		const golden = path.join(dir, "tests", "golden");
		const feasibility = await readFile(path.join(golden, "feasibility-baseline.json"), "utf8");
		const truth = await readFile(path.join(golden, "truth-baseline.json"), "utf8");

		expect(JSON.parse(feasibility)).toEqual({});
		// The pre-#442 build left this byte-identical to the compact seed.
		expect(truth).not.toBe(JSON.stringify({ [DATE]: [1700000000] }));
		expect(JSON.parse(truth)).toEqual({ [DATE]: [1700000000] });

		// Every write names its file, so what a bless changed is answerable from
		// the log rather than from `git diff` on the golden repo.
		expect(stdout).toContain("truth: blessed floor");
		expect(stdout).toContain("feasibility (kinematic): blessed ceiling");
		expect(stdout).toContain("Blessed 2 baseline(s): feasibility-baseline.json, truth-baseline.json.");
	}, 120_000);

	it("rejects --bless combined with a ratchet flag rather than silently no-opping", async () => {
		const dir = await seed({ "truth-baseline.json": { [DATE]: [1700000000] } });

		// `--bless` skips the truth report and the feasibility check for every day,
		// so the ratchets would be derived from empty measurements and write their
		// committed values straight back — a bless that reports success and does
		// not land, which is the same defect in a different costume.
		const err = await run("node", [CLI, "--bless", "--bless-truth"], { cwd: dir }).catch((e) => e);

		expect(err.code).toBe(2);
		expect(err.stderr).toContain("--bless cannot be combined with --bless-truth");
		// The day fixture must be untouched too: rejection happens before any write.
		const truth = await readFile(path.join(dir, "tests", "golden", "truth-baseline.json"), "utf8");
		expect(truth).toBe(JSON.stringify({ [DATE]: [1700000000] }));
	}, 120_000);
});
