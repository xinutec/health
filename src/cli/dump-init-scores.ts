/**
 * Diagnostic CLI: dump the per-state log-prob breakdown at a single
 * minute, sorted by total. Reveals why a specific minute's MAP is
 * what it is — split into init / entry / emission contributions so
 * the dominant factor is obvious.
 *
 * Use case: the ground-truth eval shows HSMM picking a wrong
 * `stationary @ X` at overnight minutes when Home should win. This
 * tool answers "by how much, and which factor accounts for it."
 *
 * Usage:
 *   scripts/prod-db.sh node dist/cli/dump-init-scores.js \
 *     --date 2026-05-20 --minute 0
 */

import { z } from "zod";
import { db, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { parseHourProfile } from "../geo/focus-places.js";
import { dateBoundsUtc } from "../geo/timezone.js";
import { computeVelocity, loadBiometrics } from "../geo/velocity.js";
import { buildEmissionFn } from "../hmm/emissions.js";
import { buildEntryPrior } from "../hmm/entry-prior.js";
import { buildGeometricFeasibility } from "../hmm/geometric-feasibility.js";
import { dropGpsOutliers } from "../hmm/gps-outliers.js";
import { buildInitialStatePrior } from "../hmm/initial-state.js";
import { buildObservationTensor } from "../hmm/observation.js";
import { buildStateSpace, type FocusPlaceRef, type State, stateKey } from "../hmm/state-space.js";

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

const KNOWN_LINES = [
	"Metropolitan Line",
	"Jubilee Line",
	"Victoria Line",
	"Piccadilly Line",
	"Bakerloo Line",
	"Northern Line",
	"Circle Line",
	"Hammersmith & City Line",
	"District Line",
	"Central Line",
	"Elizabeth Line",
];

interface CliArgs {
	userId: string;
	date: string;
	tz: string;
	minute: number;
	topN: number;
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	let userId = "pippijn";
	let date = "";
	let tz = "Europe/London";
	let minute = 0;
	let topN = 15;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--user") userId = args[++i] ?? userId;
		else if (a === "--date") date = args[++i] ?? "";
		else if (a === "--tz") tz = args[++i] ?? tz;
		else if (a === "--minute") minute = Number(args[++i] ?? 0);
		else if (a === "--top") topN = Number(args[++i] ?? 15);
	}
	if (!date) {
		console.error("usage: dump-init-scores --date YYYY-MM-DD --minute N [--tz tz] [--top 15]");
		process.exit(1);
	}
	return { userId, date, tz, minute, topN };
}

interface PlaceWithCoords extends FocusPlaceRef {
	lat: number;
	lon: number;
	hourProfile: readonly number[] | null;
	totalDwellSec: number;
}

async function loadFocusPlacesForUser(userId: string): Promise<PlaceWithCoords[]> {
	const rows = await db()
		.selectFrom("focus_places")
		.where("user_id", "=", userId)
		.select(["id", "display_name", "centroid_lat", "centroid_lon", "hour_profile", "total_dwell_sec"])
		.execute();
	return rows.map((r) => ({
		id: r.id,
		displayName: r.display_name,
		lat: Number(r.centroid_lat),
		lon: Number(r.centroid_lon),
		hourProfile: parseHourProfile(r.hour_profile),
		totalDwellSec: Number(r.total_dwell_sec),
	}));
}

async function main(): Promise<void> {
	const args = parseArgs();
	initPool(config.db);
	await withConnection(migrate);

	const places = await loadFocusPlacesForUser(args.userId);
	const velResult = await computeVelocity(config, args.userId, args.date, args.tz);
	const bounds = dateBoundsUtc(args.date, args.tz);
	const biom = await loadBiometrics(args.userId, bounds.startUtc, bounds.endUtc, args.tz);
	const cleanedPoints = dropGpsOutliers(velResult.points);
	const tensor = buildObservationTensor({
		date: args.date,
		tz: args.tz,
		points: cleanedPoints,
		hr: biom.hr,
		steps: biom.steps,
		sleep: biom.sleep,
	});
	if (args.minute < 0 || args.minute >= tensor.length) {
		console.error(`minute ${args.minute} out of range [0, ${tensor.length})`);
		process.exit(1);
	}
	const obs = tensor[args.minute];

	const states = buildStateSpace({ focusPlaces: places, knownLines: KNOWN_LINES });
	const placeCoords = new Map<number, { lat: number; lon: number }>();
	const placeHourProfiles = new Map<number, readonly number[]>();
	const placeVisitWeights = new Map<number, number>();
	const totalDwell = places.reduce((s, p) => s + p.totalDwellSec, 0);
	for (const p of places) {
		placeCoords.set(p.id, { lat: p.lat, lon: p.lon });
		if (p.hourProfile !== null) placeHourProfiles.set(p.id, p.hourProfile);
		placeVisitWeights.set(p.id, totalDwell > 0 ? p.totalDwellSec / totalDwell : 1 / places.length);
	}
	const baseEmission = buildEmissionFn({ placeCoords });
	const geometricFn = buildGeometricFeasibility({ placeCoords });
	const emission = (state: State, o: typeof obs): number => baseEmission(state, o) + geometricFn(state, o);
	const initialLogProb = buildInitialStatePrior();
	const entryLogProb = buildEntryPrior({ placeHourProfiles, placeVisitWeights });

	const ts = obs.ts;
	const dt = new Date(ts * 1000);
	console.log(
		`# date=${args.date} tz=${args.tz} minute=${args.minute} (local time ~${dt.toLocaleTimeString("en-GB", { timeZone: args.tz, hour: "2-digit", minute: "2-digit" })})`,
	);
	console.log(
		`# obs: gps=${obs.gps ? `${obs.gps.lat.toFixed(4)},${obs.gps.lon.toFixed(4)} @ ${obs.gps.speedKmh.toFixed(1)}km/h` : "null"} hr=${obs.hr ?? "null"} cad=${obs.cadence ?? "null"} hour=${obs.hourLocal} inBed=${obs.inBed}`,
	);
	console.log("");

	interface ScoredState {
		key: string;
		label: string;
		init: number;
		entry: number;
		emit: number;
		total: number;
	}
	const scored: ScoredState[] = [];
	for (const s of states) {
		const init = initialLogProb(s);
		const entry = entryLogProb(s, obs);
		const emit = emission(s, obs);
		const total = init + entry + emit;
		let label = stateKey(s);
		if (s.mode === "stationary" && s.placeId !== null) {
			const p = places.find((q) => q.id === s.placeId);
			label = `stationary @ ${p?.displayName ?? `#${s.placeId}`}`;
		}
		scored.push({ key: stateKey(s), label, init, entry, emit, total });
	}
	scored.sort((a, b) => b.total - a.total);

	const fmt = (n: number): string => n.toFixed(2).padStart(8);
	console.log(`   total      init     entry      emit   state`);
	console.log(`   --------  --------  --------  --------  -----`);
	for (const r of scored.slice(0, args.topN)) {
		console.log(`   ${fmt(r.total)}  ${fmt(r.init)}  ${fmt(r.entry)}  ${fmt(r.emit)}  ${r.label}`);
	}

	// Always also show Home + Work explicitly even if outside top N
	const targets = ["Home", "Work"];
	for (const target of targets) {
		const t = scored.find((s) => s.label.toLowerCase().includes(target.toLowerCase()));
		if (t && !scored.slice(0, args.topN).includes(t)) {
			console.log(`   ${fmt(t.total)}  ${fmt(t.init)}  ${fmt(t.entry)}  ${fmt(t.emit)}  ${t.label}    ← ${target}`);
		}
	}

	process.exit(0);
}

await main();
