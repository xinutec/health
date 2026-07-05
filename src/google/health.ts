/**
 * Google Health API v4 client — the bits health-sync needs.
 *
 * Unified data model: GET /v4/users/me/dataTypes/{type}/dataPoints, paginated.
 * Part of the Fitbit → Google Health migration (#260).
 */

const BASE = "https://health.googleapis.com/v4";

/** One weigh-in, mapped from a `weight` data point. */
export interface WeightMeasurement {
	/** Local civil date of the weigh-in, `YYYY-MM-DD`. */
	date: string;
	/** Weight in kilograms (Google stores integer grams). */
	kg: number;
	/** RFC-3339 instant of the measurement (for dedup / ordering). */
	ts: string;
}

interface RawDataPoint {
	weight?: {
		weightGrams?: number | string;
		sampleTime?: {
			physicalTime?: string;
			civilTime?: { date?: { year: number; month: number; day: number } };
		};
	};
}

interface ListResponse {
	dataPoints?: RawDataPoint[];
	nextPageToken?: string;
}

function civilDate(d: { year: number; month: number; day: number }): string {
	return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/**
 * Fetch every `weight` data point for the authenticated user, mapped to
 * {@link WeightMeasurement}. These are real, individually-timestamped
 * weigh-ins (not Fitbit's forward-filled daily series). Paginates fully.
 */
export async function fetchAllWeight(accessToken: string): Promise<WeightMeasurement[]> {
	const out: WeightMeasurement[] = [];
	let pageToken: string | undefined;
	do {
		const url = new URL(`${BASE}/users/me/dataTypes/weight/dataPoints`);
		url.searchParams.set("pageSize", "1000");
		if (pageToken) url.searchParams.set("pageToken", pageToken);

		const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
		const json = (await res.json()) as ListResponse;
		if (!res.ok) throw new Error(`health weight ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);

		for (const p of json.dataPoints ?? []) {
			const grams = p.weight?.weightGrams;
			const civ = p.weight?.sampleTime?.civilTime?.date;
			if (grams == null || !civ) continue;
			out.push({
				date: civilDate(civ),
				kg: Number(grams) / 1000,
				ts: p.weight?.sampleTime?.physicalTime ?? "",
			});
		}
		pageToken = json.nextPageToken;
	} while (pageToken);

	return out;
}
