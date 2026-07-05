import type * as mariadb from "mariadb";
import type { FitbitClient } from "../client.js";

interface TimeSeriesPoint {
	dateTime: string;
	value: string;
}

/** A positive numeric value, or null for "0"/blank — the body time-series
 *  carries a 0 (not a gap) for days before the first measurement. */
function positiveNum(s: string | undefined): number | null {
	const x = Number(s);
	return Number.isFinite(x) && x > 0 ? x : null;
}

/** Fetch one body time-series resource over a date range. A resource the
 *  account never recorded (e.g. body-fat without a smart scale) returns an
 *  empty series or 4xx — treat both as "no data" so it can't sink the others. */
async function bodySeries(
	client: FitbitClient,
	resource: "weight" | "bmi" | "fat",
	start: string,
	end: string,
): Promise<TimeSeriesPoint[]> {
	try {
		const res = await client.get<Record<string, TimeSeriesPoint[]>>(
			`/1/user/-/body/${resource}/date/${start}/${end}.json`,
		);
		return res[`body-${resource}`] ?? [];
	} catch (e) {
		console.warn(`body ${resource} ${start}..${end}: ${e instanceof Error ? e.message : String(e)}`);
		return [];
	}
}

/**
 * Sync weight / BMI / body-fat for a date range.
 *
 * Reads Fitbit's BODY TIME-SERIES (`/body/{resource}/date/{start}/{end}`), NOT
 * the weight LOG (`/body/log/weight/...`). The log carries only discrete
 * weigh-in *events*; an account whose weight is fed in by a connected app /
 * scale that writes the daily series but no log events returns an EMPTY log
 * while the series holds the full history (the 2026 finding: pippijn's log was
 * empty but the series had 1095 daily points back to 2023). The series is the
 * canonical source. BMI and body-fat are sibling series, merged in by date.
 *
 * The series is forward-filled by Fitbit (a value every day, carried from the
 * last measurement); we store it as given — that is the resolution Fitbit
 * exposes. Idempotent upsert keyed on (user, date).
 */
export async function syncBody(
	client: FitbitClient,
	conn: mariadb.Connection,
	userId: string,
	startDate: string,
	endDate: string,
): Promise<number> {
	const [weight, bmi, fat] = await Promise.all([
		bodySeries(client, "weight", startDate, endDate),
		bodySeries(client, "bmi", startDate, endDate),
		bodySeries(client, "fat", startDate, endDate),
	]);

	const byDate = new Map<string, { weight: number | null; bmi: number | null; fat: number | null }>();
	const at = (date: string) => {
		let v = byDate.get(date);
		if (!v) {
			v = { weight: null, bmi: null, fat: null };
			byDate.set(date, v);
		}
		return v;
	};
	for (const p of weight) at(p.dateTime).weight = positiveNum(p.value);
	for (const p of bmi) at(p.dateTime).bmi = positiveNum(p.value);
	for (const p of fat) at(p.dateTime).fat = positiveNum(p.value);

	let count = 0;
	for (const [date, v] of byDate) {
		if (v.weight === null && v.bmi === null && v.fat === null) continue;
		await conn.query(
			`INSERT INTO body (user_id, date, weight_kg, bmi, body_fat_pct) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE weight_kg=VALUES(weight_kg), bmi=VALUES(bmi), body_fat_pct=VALUES(body_fat_pct)`,
			[userId, date, v.weight, v.bmi, v.fat],
		);
		count++;
	}

	console.log(`[${userId}] Synced ${count} body entries (${startDate}..${endDate})`);
	return count;
}
