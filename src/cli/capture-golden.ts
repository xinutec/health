/**
 * CLI: capture a deterministic golden fixture for one (date, user).
 *
 * Phase 6f of `docs/proposals/2026-06-deterministic-fixtures.md`.
 *
 * Loads the day's `ClassificationInputs` with a `RecordingOsmAdapter`
 * wrapping the production `dbOsmAdapter`, runs the pure classification
 * core once, and writes a self-contained `CapturedDay` fixture: the input
 * closure (bounded row-sets + the recorded OSM trace) plus the expected
 * normalised day-state timeline. `golden-check` then replays it with a
 * `FixtureOsmAdapter` — no DB, no network, no drift.
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
const result = await computeVelocityFromInputs(inputs);

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
	inputs: toSerializedInputs(inputs, recorder.trace),
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
