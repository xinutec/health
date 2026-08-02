/**
 * CLI: capture a deterministic golden fixture for one (date, user).
 *
 * Phase 6f of `docs/proposals/2026-06-deterministic-fixtures.md`.
 *
 * Loads the day's `ClassificationInputs` with a `RecordingOsmAdapter`
 * wrapping the production `dbOsmAdapter` and writes a self-contained
 * `CapturedDay` fixture: the input closure (bounded row-sets + the recorded
 * OSM trace) plus the expected normalised day-state timeline. `golden-check`
 * then replays it — no DB, no network, no drift.
 *
 * # Two passes, and why
 *
 * There are two OSM oracles and they are not equivalent (#412): the live
 * `dbOsmAdapter`, and `RowSetOsmAdapter` computing the five kernel lookups
 * from pushed raw rows. Replay uses the KERNEL, so the blessed output must
 * come from the kernel too — otherwise the corpus grades a run it did not
 * capture, and the kernel's delegated lookups go unrecorded. Pass 1 exists
 * only to record what the live oracle answers, so the fixture keeps enough
 * evidence to measure the two against each other. See the comments below.
 *
 * Connection: like the v1 harness, this needs the prod DB. Port-forward
 * it (see the golden-check.ts header) and run with the usual
 * DB_* / NC_* env:
 *
 *   node dist/cli/capture-golden.js <date> <user> <timezone> [--description "..."]
 *
 * Writes tests/golden/days/<date>-<user>.json (gitignored — the fixture
 * carries real GPS / place names / biometrics).
 *
 * Capture is deliberate: this is the only path that pulls fresh inputs
 * from prod. `golden-check --bless` only re-derives the expected
 * output from the already-captured inputs; it never re-pulls.
 */

import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { loadClassificationInputs } from "../geo/load-classification-inputs.js";
import { dbOsmAdapter } from "../geo/osm-adapter.js";
import { RecordingOsmAdapter } from "../geo/osm-adapter-recording.js";
import { RowSetOsmAdapter } from "../geo/osm-adapter-rowset.js";
import { loadOsmRowSet } from "../geo/osm-rowset.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { type CapturedDay, FIXTURE_FORMAT_VERSION, toSerializedInputs } from "./fixture-day.js";
import { normalizeStates } from "./state-diff.js";

const config = z
	.object({
		db: z.object({
			host: z.string().default("health-db"),
			port: z.coerce.number().default(3306),
			user: z.string(),
			password: z.string(),
			database: z.string().default("health"),
		}),
		nextcloud: z.object({
			baseUrl: z.string().url().default("https://dash.xinutec.org"),
			clientId: z.string().min(1),
			clientSecret: z.string().min(1),
		}),
	})
	.parse({
		db: {
			host: process.env.DB_HOST,
			port: process.env.DB_PORT,
			user: process.env.DB_USER,
			password: process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
		},
		nextcloud: {
			baseUrl: process.env.NC_BASE_URL,
			clientId: process.env.NC_CLIENT_ID,
			clientSecret: process.env.NC_CLIENT_SECRET,
		},
	});

const DAYS_DIR = path.join(process.cwd(), "tests", "golden", "days");

function usage(): never {
	console.error(
		'Usage: node dist/cli/capture-golden.js <date> <user> <timezone> [--description "..."]\n' +
			"Example: node dist/cli/capture-golden.js 2026-05-15 pippijn Europe/London\n",
	);
	process.exit(2);
}

/** Best-effort current git rev for drift context. Never fatal — capture
 *  may run inside a pod with no git. */
function gitSha(): string {
	try {
		return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

const args = process.argv.slice(2);
if (args.length < 3) usage();
const date = args[0];
const user = args[1];
const tz = args[2];
let description = "";
for (let i = 3; i < args.length; i++) {
	if (args[i] === "--description") {
		description = args[i + 1] ?? "";
		i++;
	} else {
		usage();
	}
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
	console.error(`bad date format: ${date} (expected YYYY-MM-DD)`);
	process.exit(2);
}

initPool(config.db);
await withConnection(migrate);

console.log(`Capturing ${date} ${user} (${tz}) with a recording OSM adapter…`);

const recorder = new RecordingOsmAdapter(dbOsmAdapter);
const inputs = await loadClassificationInputs(config, { userId: user, date, displayTz: tz }, recorder);

// PASS 1 — the LIVE-oracle branch. Its output is discarded; what it is for is
// the recorder. Capturing MariaDB's answers to the five kernel lookups is what
// lets a fixture be its own evidence for oracle divergence
// (`lean/experiments/osm-oracle-parity.mts`, #412) without a live mirror to
// re-derive one side. Dropping this pass would make the corpus self-consistent
// and permanently unable to detect divergence from what production serves,
// which is the one thing it exists to measure.
console.log("Pass 1/2: recording the live-oracle branch…");
await computeVelocityFromInputs(inputs);

// The raw OSM rows within the day's buffered track. Heavy (~20-40 s, tens of
// thousands of rows); this is the offline capture path `loadOsmRowSet` is
// written for, and the reason production still serves `dbOsmAdapter`.
const track = [...inputs.phonetrack.today, ...inputs.phonetrack.morning, ...inputs.phonetrack.priorEvening];
console.log(`Loading the OSM row-set for ${track.length} fixes…`);
const osmRowSet = await loadOsmRowSet(track);
console.log(`  ${osmRowSet.points.length} points / ${osmRowSet.lines.length} lines`);

// PASS 2 — the KERNEL branch, which is the one `golden` and `walk-gate` replay
// (`inputsFromFixture` defaults to `"rows"`). Blessing pass 1's output while
// grading pass 2's was the defect behind #408: the two oracles take different
// branches, so the kernel would ask for delegated lookups — a zoom-16
// `reverseGeocode` on 07-15 — that the live branch never made and the capture
// therefore never recorded. Re-capturing could not fix that, because it
// re-recorded the live branch again.
//
// The SAME recorder is reused deliberately: `RecordingOsmAdapter` accumulates,
// so the stored trace ends up the UNION of both branches. Both replay arms
// then work, and the oracle comparison above stays possible.
console.log("Pass 2/2: running the kernel branch (this is what gets blessed)…");
const result = await computeVelocityFromInputs({ ...inputs, osm: new RowSetOsmAdapter(osmRowSet, recorder) });

const captured: CapturedDay = {
	meta: {
		fixtureFormatVersion: FIXTURE_FORMAT_VERSION,
		capturedAt: new Date().toISOString(),
		capturedAtCodeSha: gitSha(),
		date,
		user,
		tz,
		description,
	},
	inputs: toSerializedInputs(inputs, recorder.trace, osmRowSet),
	expected: { velocity: normalizeStates(result.states, tz) },
};

const traceCount =
	Object.keys(recorder.trace.nearbyWays).length +
	Object.keys(recorder.trace.nearbyStations).length +
	Object.keys(recorder.trace.nearbyLandmarks).length +
	Object.keys(recorder.trace.linesAtPoint).length +
	Object.keys(recorder.trace.reverseGeocode).length;

await mkdir(DAYS_DIR, { recursive: true });
const outPath = path.join(DAYS_DIR, `${date}-${user}.json`);
await writeFile(outPath, `${JSON.stringify(captured, null, "\t")}\n`, "utf8");

console.log(
	`Wrote ${outPath}\n` +
		`  ${captured.expected.velocity.length} states · ${traceCount} unique OSM lookups captured.\n` +
		`  Replay it with: node dist/cli/golden-check.js`,
);
process.exit(0);
