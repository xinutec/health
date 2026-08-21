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
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type CapturedDay, FIXTURE_FORMAT_VERSION, nextExpected } from "../src/cli/fixture-day.js";
import type { NormalizedState } from "../src/cli/state-diff.js";
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
		// ⚠ A FROZEN ARM, because `--bless` once deleted it. The shape does not
		// have to be a real capture — `compare-day` is not run here — only
		// present, distinguishable, and under `expected` where a bless writes.
		expected: { velocity: [], tsArm: { capture: { date: DATE }, osmAnswers: {} } },
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
	// Say so plainly rather than letting the spawn fail with a bare exit 1 and a
	// "Cannot find module" nobody reads: `pnpm test` does not build, so this
	// suite needs `pnpm run build` first (CI runs it as its own step).
	beforeAll(async () => {
		await access(CLI).catch(() => {
			throw new Error(`${CLI} is missing — this suite drives the built CLI. Run \`pnpm run build\` first.`);
		});
	});

	it("leaves the frozen TS arm alone — it blesses one field, not the object", async () => {
		// ⚠ REGRESSION TEST FOR A DESTRUCTIVE BLESS. `--bless` wrote
		// `expected: { velocity: actual }`, rebuilding the object and dropping
		// `expected.tsArm` — the frozen TS arm (#975) that is the day gate's ONLY
		// oracle now the cascade is deleted. One run erased it from all 41
		// fixtures.
		//
		// It was not silent — `compare-day` calls a missing arm NO ORACLE and
		// that is red — but it was UNRECOVERABLE: `--freeze` went with the
		// cascade, so nothing in the tree can rebuild an oracle. Recovery meant
		// restoring 41 files from the corpus repo's history.
		//
		// `docs/proposals/2026-06-deterministic-fixtures.md` already said the
		// rule: "`--bless` updates `expected.velocity` only". This pins it.
		const dir = await seed({});
		await run("node", [CLI, "--bless"], { cwd: dir });

		const after = JSON.parse(await readFile(path.join(dir, "tests", "golden", "days", `${DATE}.json`), "utf8"));
		expect(after.expected.tsArm).toEqual({ capture: { date: DATE }, osmAnswers: {} });
		// And the bless still did its own job, so this cannot pass by not running.
		expect(after.expected.velocity).toEqual([]);
	});

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

// ---------------------------------------------------------------------------
// The rule both fixture writers share
// ---------------------------------------------------------------------------

describe("nextExpected", () => {
	// ⚠ TWO WRITERS HAD THE SAME DEFECT. `golden-check --bless` and
	// `capture-golden` each built `expected: { velocity }` from scratch, dropping
	// `expected.tsArm` — the day gate's only oracle once the cascade is deleted,
	// and one nothing in the tree can rebuild. The bless fired and erased it from
	// 41 fixtures; the capture path had not fired yet. The rule lives in one
	// place now so a third writer cannot re-derive the bug.
	type Arm = NonNullable<CapturedDay["expected"]["tsArm"]>;
	// The arm's shape does not matter here — only that it is carried by
	// IDENTITY. A structural stand-in keeps the test about the rule.
	const arm = { capture: { date: DATE }, osmAnswers: {} } as unknown as Arm;
	const state = (from: string): NormalizedState => ({ from, to: from, mode: "stationary", label: "", asleep: false });
	const withArm = (): CapturedDay => ({ expected: { velocity: [state("00:00")], tsArm: arm } }) as CapturedDay;

	it("carries every other key forward while replacing the timeline", () => {
		const out = nextExpected(withArm(), [state("09:00")]);
		expect(out.tsArm).toBe(arm);
		expect(out.velocity).toEqual([state("09:00")]);
	});

	it("writes a bare timeline for a day captured for the first time", () => {
		// ⚠ It cannot INVENT an arm, and must not pretend to — a first capture
		// legitimately has none, and closing that gap is #1063's decision.
		expect(nextExpected(null, [])).toEqual({ velocity: [] });
		expect(nextExpected(undefined, [])).toEqual({ velocity: [] });
	});

	it("does not mutate the fixture it read", () => {
		// The callers reuse `previous` after this — `capture-golden` logs off it.
		const previous = withArm();
		nextExpected(previous, [state("09:00")]);
		expect(previous.expected.velocity).toEqual([state("00:00")]);
	});
});
