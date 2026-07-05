import type * as mariadb from "mariadb";
import type { FitbitClient } from "../client.js";

interface DailySummary {
	summary: {
		steps: number;
		caloriesOut: number;
		activityCalories: number;
		distances: Array<{ activity: string; distance: number }>;
		floors: number;
		elevation: number;
		sedentaryMinutes: number;
		lightlyActiveMinutes: number;
		fairlyActiveMinutes: number;
		veryActiveMinutes: number;
		restingHeartRate?: number;
		activeScore: number;
	};
}

export async function syncActivity(
	client: FitbitClient,
	conn: mariadb.Connection,
	userId: string,
	startDate: string,
	endDate: string,
): Promise<number> {
	let synced = 0;

	for (let d = new Date(startDate); d <= new Date(endDate); d.setDate(d.getDate() + 1)) {
		const date = d.toISOString().slice(0, 10);
		const { summary: s } = await client.get<DailySummary>(`/1/user/-/activities/date/${date}.json`);
		const dist = s.distances.find((d) => d.activity === "total")?.distance ?? 0;

		await conn.query(
			`INSERT INTO daily_activity
        (user_id, date, steps, calories_total, calories_active, distance_km, floors, elevation_m,
         minutes_sedentary, minutes_lightly_active, minutes_fairly_active, minutes_very_active,
         active_score, resting_heart_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         steps=VALUES(steps), calories_total=VALUES(calories_total), calories_active=VALUES(calories_active),
         distance_km=VALUES(distance_km), floors=VALUES(floors), elevation_m=VALUES(elevation_m),
         minutes_sedentary=VALUES(minutes_sedentary), minutes_lightly_active=VALUES(minutes_lightly_active),
         minutes_fairly_active=VALUES(minutes_fairly_active), minutes_very_active=VALUES(minutes_very_active),
         active_score=VALUES(active_score), resting_heart_rate=VALUES(resting_heart_rate)`,
			[
				userId,
				date,
				s.steps,
				s.caloriesOut,
				s.activityCalories,
				dist,
				s.floors,
				s.elevation,
				s.sedentaryMinutes,
				s.lightlyActiveMinutes,
				s.fairlyActiveMinutes,
				s.veryActiveMinutes,
				s.activeScore,
				s.restingHeartRate ?? null,
			],
		);
		synced++;

		if (client.rateLimitRemaining <= 10) {
			console.log(`[${userId}] Activity paused at ${date}, rate limit low`);
			break;
		}
	}

	console.log(`[${userId}] Synced ${synced} days of activity`);
	return synced;
}
