/**
 * Backtest CLI: compares two refineMode classifier configurations across
 * a date range, diffing the day-state timelines per day.
 *
 * Two compare modes (selected with `--compare`):
 *   - `scorer` (default): legacy cascade vs factor scorer
 *     (`USE_FACTOR_SCORER=0` vs `=1`). Answers "what does flipping the
 *     scorer prod flag change?"
 *   - `biometric`: factor scorer alone vs factor scorer + biometric
 *     factor (`USE_FACTOR_SCORER=1` for both; `USE_BIOMETRIC_FACTOR=0`
 *     vs `=1`). Answers "what does the biometric corrector migration
 *     into the scorer change once the scorer is on?"
 *
 * Purpose: measure what flipping a prod flag would do *before* actually
 * flipping it — every factor change can be re-run against the same
 * range to confirm the change moves the right segments in the right
 * direction. (Historical note: the cascade-side factor-scorer flag this
 * was built to gate was never activated; that line was abandoned in
 * favour of the decoder — see docs/proposals/decoder-roadmap.md. The
 * harness itself remains the flag-backtest tool.)
 *
 * Usage (run via `scripts/backtest.sh` so the prod-db tunnel + env are
 * set up):
 *
 *   scripts/backtest.sh                          # last 7 days, scorer
 *   scripts/backtest.sh --days 30                # last 30 days, scorer
 *   scripts/backtest.sh --from 2026-05-12 --to 2026-05-22
 *   scripts/backtest.sh --compare biometric --days 7
 *   scripts/backtest.sh --user pippijn --tz Europe/London
 *
 * Exit 0 always (measurement tool, not regression detector); exit 2
 * on usage error or DB connect failure.
 *
 * Performance note: each day is computed twice (flags flipped between
 * runs). computeVelocity is itself uncached (only the route handler
 * caches), so each comparison costs ~2 × full pipeline + 2 × PhoneTrack
 * fetch. For ~7 days that is well under a minute; for 30 days a few
 * minutes.
 */

import { z } from "zod";
import { initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { computeVelocity } from "../geo/velocity.js";
import { diffStates, normalizeStates } from "./state-diff.js";

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

type CompareMode = "scorer" | "biometric";

interface BacktestArgs {
	from: string;
	to: string;
	user: string;
	tz: string;
	compare: CompareMode;
}

function usage(message?: string): never {
	if (message) console.error(`backtest-classification: ${message}`);
	console.error(
		"Usage:\n" +
			"  backtest-classification --days N           # last N days, ending yesterday\n" +
			"  backtest-classification --from YYYY-MM-DD --to YYYY-MM-DD\n" +
			"Optional:\n" +
			"  --user <id>           (default: pippijn)\n" +
			"  --tz <iana>           (default: Europe/London)\n" +
			"  --compare <mode>      scorer (default) | biometric",
	);
	process.exit(2);
}

/** Yesterday in UTC as YYYY-MM-DD — the safe right edge of any
 *  measurement window; today's data is still accumulating. */
function yesterdayUtc(): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - 1);
	return d.toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): BacktestArgs {
	let from: string | null = null;
	let to: string | null = null;
	let days: number | null = null;
	let user = "pippijn";
	let tz = "Europe/London";
	let compare: CompareMode = "scorer";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--from") from = argv[++i] ?? usage("--from needs YYYY-MM-DD");
		else if (a === "--to") to = argv[++i] ?? usage("--to needs YYYY-MM-DD");
		else if (a === "--days") {
			const next = argv[++i];
			if (!next || !/^\d+$/.test(next)) usage("--days needs a positive integer");
			days = Number(next);
		} else if (a === "--user") user = argv[++i] ?? usage("--user needs an id");
		else if (a === "--tz") tz = argv[++i] ?? usage("--tz needs an IANA zone");
		else if (a === "--compare") {
			const next = argv[++i];
			if (next !== "scorer" && next !== "biometric") usage("--compare needs scorer|biometric");
			compare = next;
		} else usage(`unknown argument: ${a}`);
	}
	if (from !== null || to !== null) {
		if (from === null || to === null) usage("--from and --to must be given together");
		if (days !== null) usage("--days is mutually exclusive with --from/--to");
		if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
			usage("dates must be YYYY-MM-DD");
		}
		if (from > to) usage("--from must be ≤ --to");
		return { from, to, user, tz, compare };
	}
	// Default: last `days` days (default 7), ending yesterday.
	const N = days ?? 7;
	const end = new Date(`${yesterdayUtc()}T00:00:00Z`);
	const start = new Date(end);
	start.setUTCDate(start.getUTCDate() - (N - 1));
	return {
		from: start.toISOString().slice(0, 10),
		to: end.toISOString().slice(0, 10),
		user,
		tz,
		compare,
	};
}

/** Yield every date string in [from, to] inclusive, in YYYY-MM-DD. */
function* datesInRange(from: string, to: string): Generator<string> {
	const start = new Date(`${from}T00:00:00Z`);
	const end = new Date(`${to}T00:00:00Z`);
	for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
		yield d.toISOString().slice(0, 10);
	}
}

interface ComparisonOutcome {
	kind: "match" | "diff" | "error";
	lines?: string[];
	errorMessage?: string;
}

/** Configure the two flag env states for a given compare mode.
 *
 *  Both flags are read fresh every call to refineMode (no caching),
 *  so in-process env mutation is sufficient to switch behaviour
 *  between the two computeVelocity runs. */
function flagStatesFor(mode: CompareMode): { left: Record<string, string>; right: Record<string, string> } {
	switch (mode) {
		case "scorer":
			// legacy cascade vs factor scorer (biometric corrector still
			// on the cascade for both — controlled by the legacy code path,
			// not USE_BIOMETRIC_FACTOR).
			return { left: {}, right: { USE_FACTOR_SCORER: "1" } };
		case "biometric":
			// scorer alone vs scorer + biometric factor. Both runs have
			// the factor scorer on; only the biometric-corrector path
			// changes (cascade-after vs candidate-filter-inside).
			return {
				left: { USE_FACTOR_SCORER: "1" },
				right: { USE_FACTOR_SCORER: "1", USE_BIOMETRIC_FACTOR: "1" },
			};
	}
}

function applyEnv(state: Record<string, string>): void {
	delete process.env.USE_FACTOR_SCORER;
	delete process.env.USE_BIOMETRIC_FACTOR;
	for (const [k, v] of Object.entries(state)) process.env[k] = v;
}

async function compareDay(date: string, user: string, tz: string, mode: CompareMode): Promise<ComparisonOutcome> {
	const states = flagStatesFor(mode);
	applyEnv(states.left);
	const left = await computeVelocity(config, user, date, tz);
	applyEnv(states.right);
	let right: Awaited<ReturnType<typeof computeVelocity>>;
	try {
		right = await computeVelocity(config, user, date, tz);
	} finally {
		applyEnv({});
	}

	const leftNorm = normalizeStates(left.states, tz);
	const rightNorm = normalizeStates(right.states, tz);
	const d = diffStates(leftNorm, rightNorm);
	return d.identical ? { kind: "match" } : { kind: "diff", lines: d.lines };
}

const args = parseArgs(process.argv.slice(2));

const legend =
	args.compare === "scorer" ? "(-=legacy cascade, +=factor scorer)" : "(-=scorer only, +=scorer + biometric factor)";

console.log(
	`backtest-classification: ${args.from} → ${args.to}  user=${args.user}  tz=${args.tz}  compare=${args.compare}  ${legend}`,
);

initPool(config.db);
await withConnection(migrate);

let total = 0;
let matched = 0;
let differed = 0;
let errored = 0;

for (const date of datesInRange(args.from, args.to)) {
	total++;
	try {
		const out = await compareDay(date, args.user, args.tz, args.compare);
		if (out.kind === "match") {
			matched++;
			console.log(`MATCH  ${date}`);
		} else {
			differed++;
			console.log(`\nDIFF   ${date}`);
			for (const line of out.lines ?? []) console.log(line);
		}
	} catch (e) {
		errored++;
		const message = e instanceof Error ? e.message : String(e);
		console.log(`ERROR  ${date}: ${message}`);
	}
}

console.log(`\n${total} day(s): ${matched} match · ${differed} differ · ${errored} errored`);
process.exit(0);
