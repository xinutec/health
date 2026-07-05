/**
 * Diagnostic: dump heuristic segment durations per mode from a
 * date range. Used during HSMM development to inspect the empirical
 * shape of `P_d(d | mode)` and decide which modes need a fit.
 *
 * Output: per-mode histogram of segment durations (in minutes) plus
 * basic stats (count, mean, median, p90, max).
 *
 * Usage (via prod-db.sh):
 *
 *   scripts/prod-db.sh node dist/cli/dump-segment-durations.js \
 *     --user pippijn --from 2026-04-01 --to 2026-05-15
 */

import { z } from "zod";
import { initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import type { TransportMode } from "../geo/segments.js";
import { computeVelocity, type EnrichedSegment } from "../geo/velocity.js";

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

const KNOWN_MODES: ReadonlySet<TransportMode> = new Set([
	"stationary",
	"walking",
	"cycling",
	"driving",
	"train",
	"plane",
	"unknown",
]);

function asTransportMode(s: string): TransportMode | null {
	return KNOWN_MODES.has(s as TransportMode) ? (s as TransportMode) : null;
}

function* dateRange(fromIso: string, toIso: string): Generator<string> {
	const from = new Date(`${fromIso}T00:00:00Z`);
	const to = new Date(`${toIso}T00:00:00Z`);
	for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
		yield d.toISOString().slice(0, 10);
	}
}

function segmentDurationMinutes(seg: EnrichedSegment): number {
	return Math.max(1, Math.round((seg.endTs - seg.startTs) / 60));
}

function summarise(durations: number[]): { count: number; mean: number; median: number; p90: number; max: number } {
	if (durations.length === 0) return { count: 0, mean: 0, median: 0, p90: 0, max: 0 };
	const sorted = [...durations].sort((a, b) => a - b);
	const sum = sorted.reduce((s, v) => s + v, 0);
	const mid = sorted.length >> 1;
	const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
	const p90 = sorted[Math.floor(sorted.length * 0.9)];
	return { count: sorted.length, mean: sum / sorted.length, median, p90, max: sorted[sorted.length - 1] };
}

function histogram(durations: number[], bins: readonly [number, number][]): { [range: string]: number } {
	const result: { [range: string]: number } = {};
	for (const [lo, hi] of bins) {
		const key = hi === Infinity ? `${lo}+` : `${lo}-${hi - 1}`;
		result[key] = durations.filter((d) => d >= lo && d < hi).length;
	}
	return result;
}

const HIST_BINS: ReadonlyArray<[number, number]> = [
	[1, 2],
	[2, 5],
	[5, 10],
	[10, 30],
	[30, 60],
	[60, 120],
	[120, 240],
	[240, 480],
	[480, Infinity],
];

interface CliArgs {
	userId: string;
	tz: string;
	fromDate: string;
	toDate: string;
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	let userId = "pippijn";
	let tz = "Europe/London";
	let fromDate = "";
	let toDate = "";
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--user") userId = args[++i] ?? userId;
		else if (args[i] === "--tz") tz = args[++i] ?? tz;
		else if (args[i] === "--from") fromDate = args[++i] ?? "";
		else if (args[i] === "--to") toDate = args[++i] ?? "";
	}
	if (!fromDate || !toDate) throw new Error("--from YYYY-MM-DD --to YYYY-MM-DD required");
	return { userId, tz, fromDate, toDate };
}

async function main(): Promise<void> {
	const args = parseArgs();
	initPool(config.db);
	await withConnection(migrate);

	console.error(`# Dumping segment durations — user=${args.userId} ${args.fromDate} → ${args.toDate}`);

	const byMode: Record<string, number[]> = {};
	let dayCount = 0;
	let failedDayCount = 0;

	for (const date of dateRange(args.fromDate, args.toDate)) {
		try {
			const velResult = await computeVelocity(config, args.userId, date, args.tz);
			for (const seg of velResult.segments) {
				const rawMode = seg.refinedMode ?? seg.mode;
				const mode = asTransportMode(rawMode);
				if (mode === null) continue;
				const dur = segmentDurationMinutes(seg);
				if (!byMode[mode]) byMode[mode] = [];
				byMode[mode].push(dur);
			}
			dayCount++;
		} catch (e) {
			console.error(`  [${date}] FAILED: ${e instanceof Error ? e.message : String(e)}`);
			failedDayCount++;
		}
	}

	console.error(`# ${dayCount} days included, ${failedDayCount} failed`);
	console.error();

	for (const mode of [...KNOWN_MODES]) {
		const ds = byMode[mode] ?? [];
		const s = summarise(ds);
		console.log(
			`${mode.padEnd(12)} count=${s.count.toString().padStart(5)}  mean=${s.mean.toFixed(0).padStart(4)}min  median=${s.median.toFixed(0).padStart(4)}min  p90=${s.p90.toFixed(0).padStart(4)}min  max=${s.max.toFixed(0).padStart(4)}min`,
		);
		if (s.count > 0) {
			const hist = histogram(ds, HIST_BINS);
			const histLine = Object.entries(hist)
				.map(([range, n]) => `${range}m:${n}`)
				.join("  ");
			console.log(`              ${histLine}`);
		}
	}

	process.exit(0);
}

await main();
