/**
 * CLI tool: capture a (user, date) as a fixture JSON for the
 * classification-test corpus.
 *
 * Dumps the day's filtered GPS fixes + classifier output + a
 * placeholder `groundTruth` block intended for hand-editing. The
 * resulting file is the unit-of-fixture for:
 *
 *   - CI classification-snapshot regression tests (Phase 1)
 *   - Phase 1 factor-weight calibration
 *   - Phase 2 commute-prior bootstrap-bias audit fixture validation
 *
 * Usage (from inside the health pod):
 *   node dist/cli/capture-day.js <date> <user> <timezone> [--out <path>]
 *
 * Example:
 *   node dist/cli/capture-day.js 2026-05-12 pippijn Europe/London
 *
 * Writes to tests/fixtures/days/<date>-<user>.json by default.
 *
 * The fixture format intentionally stores classifier output verbatim
 * (not just the GPS + biometric inputs). That makes the file
 * self-contained: snapshot tests can diff against `segments` directly
 * without re-running the pipeline. When the classifier changes
 * (bumping CURRENT_CLASSIFIER_VERSION), regenerate the fixture by
 * running this CLI again — the regenerated file is what gets reviewed
 * in the PR. See docs/proposals/2026-05-scored-classification.md
 * "CI enforcement" section.
 *
 * The `groundTruth` block is `null` on first capture and must be
 * filled in by hand if the fixture is being used as calibration data
 * (i.e. "this is the correct answer," not "this is what the
 * classifier currently produces"). The CI snapshot only needs the
 * `segments` field; only calibration fixtures need `groundTruth`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { computeVelocity, type EnrichedSegment } from "../geo/velocity.js";
import type { DayState } from "../sleep/day-state.js";

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

function usage(): never {
	console.error(
		"Usage: node dist/cli/capture-day.js <date> <user> <timezone> [--out <path>]\n" +
			"Example: node dist/cli/capture-day.js 2026-05-12 pippijn Europe/London\n",
	);
	process.exit(2);
}

const args = process.argv.slice(2);
if (args.length < 3) usage();

const date = args[0];
const userId = args[1];
const tz = args[2];

let outPath: string | null = null;
for (let i = 3; i < args.length; i++) {
	if (args[i] === "--out") {
		outPath = args[i + 1] ?? null;
		i++;
	} else {
		usage();
	}
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
	console.error(`bad date format: ${date} (expected YYYY-MM-DD)`);
	process.exit(2);
}

// Default output path. Relative to the working directory the CLI is
// run from — when invoked via `kubectl exec` inside the pod, the pod
// has the repo's `tests/fixtures/days/` baked into the image at
// `/app/tests/fixtures/days/`, but the *runtime* writes should land
// in `/tmp/` and be copied out (the pod's filesystem is ephemeral).
// Hence: when no --out is given, write to /tmp and instruct the
// caller to copy out.
const defaultOut = `/tmp/${date}-${userId}.json`;
const target = outPath ?? defaultOut;

initPool(config.db);
await withConnection(migrate);

console.log(`Capturing ${date} for ${userId} (${tz}) → ${target}\n`);

const { points, segments, states } = await computeVelocity(config, userId, date, tz);

const fixture: Fixture = {
	captured_at: new Date().toISOString(),
	captured_with_classifier_version: 1, // placeholder until classifier-version land
	user_id: userId,
	date,
	display_tz: tz,
	points: points.map((p) => ({
		ts: p.ts,
		lat: p.lat,
		lon: p.lon,
		speed_kmh: p.speed_kmh,
		bearing: p.bearing,
	})),
	segments: segments.map(stripVolatileFields),
	states,
	ground_truth: null,
};

await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(fixture, null, "\t")}\n`, "utf8");

console.log(
	`Wrote ${fixture.points.length} points, ${fixture.segments.length} segments.\n` +
		`groundTruth is null — hand-edit to use this fixture as calibration data.\n` +
		`If you ran this inside a pod, copy out with:\n` +
		`  kubectl cp <pod>:${target} tests/fixtures/days/${date}-${userId}.json`,
);

process.exit(0);

// ============================================================================

interface FixturePoint {
	ts: number;
	lat: number;
	lon: number;
	speed_kmh: number;
	bearing: number;
}

interface Fixture {
	captured_at: string;
	captured_with_classifier_version: number;
	user_id: string;
	date: string;
	display_tz: string;
	points: FixturePoint[];
	segments: Omit<EnrichedSegment, never>[];
	states: DayState[];
	ground_truth: GroundTruth | null;
}

interface GroundTruth {
	notes?: string;
	spans?: Array<{
		from: string; // "HH:MM" in display_tz
		to: string; // "HH:MM" in display_tz
		mode: string;
		way_name?: string;
		place?: string;
	}>;
}

/** Remove fields that would cause spurious diffs on regeneration:
 *  `biometrics.sampleCount` is stable across regenerations, but the
 *  timing-related counters in there aren't. Future versions of this
 *  helper may also drop fields that depend on data outside the
 *  classifier (e.g. focus_places.amenity_label looks up against the
 *  current focus_places table, which changes when mining runs).
 *  Kept minimal for now — just a passthrough — and extended when
 *  spurious diffs surface in practice. */
function stripVolatileFields(seg: EnrichedSegment): EnrichedSegment {
	return seg;
}
