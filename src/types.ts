// Shared types between backend and frontend.
// DB row shapes match the MariaDB schema.

export interface ActivityDay {
	user_id: string;
	date: string;
	steps: number;
	calories_total: number;
	calories_active: number;
	distance_km: number;
	floors: number | null;
	elevation_m: number | null;
	minutes_sedentary: number;
	minutes_lightly_active: number;
	minutes_fairly_active: number;
	minutes_very_active: number;
	active_score: number;
	resting_heart_rate: number | null;
}

export interface SleepLog {
	user_id: string;
	log_id: import("./db/branded.js").FitbitSleepLogId;
	date: string;
	start_time: string;
	end_time: string;
	duration_ms: number;
	efficiency: number;
	minutes_asleep: number;
	minutes_awake: number;
	minutes_deep: number | null;
	minutes_light: number | null;
	minutes_rem: number | null;
	minutes_wake: number | null;
	is_main_sleep: boolean;
}

export interface HeartRateZone {
	user_id: string;
	date: string;
	zone_name: string;
	minutes: number;
	calories: number;
	min_bpm: number;
	max_bpm: number;
}

export interface HeartRateIntraday {
	user_id: string;
	ts: string;
	bpm: number;
}

export interface BodyEntry {
	user_id: string;
	date: string;
	weight_kg: number | null;
	bmi: number | null;
	body_fat_pct: number | null;
}

export interface SpO2Daily {
	user_id: string;
	date: string;
	avg_value: number;
	min_value: number;
	max_value: number;
}

export interface HrvDaily {
	user_id: string;
	date: string;
	daily_rmssd: number;
	deep_rmssd: number;
}

export interface BreathingRateDay {
	user_id: string;
	date: string;
	full_sleep_rate: number | null;
	deep_sleep_rate: number | null;
	light_sleep_rate: number | null;
	rem_sleep_rate: number | null;
}

export interface SkinTemperatureDay {
	user_id: string;
	date: string;
	relative_deviation: number;
}

export interface DeviceInfo {
	user_id: string;
	device_id: string;
	device_version: string;
	type: string;
	battery: string;
	last_sync_time: string;
}

export interface UserSession {
	userId: string;
	displayName: string;
	/** Present when this request is authenticated via a share token
	 *  (the recipient of a share link), not the owner's session cookie.
	 *  `window` is the inclusive [from, to] date range the recipient
	 *  is allowed to query — the velocity endpoint rejects dates
	 *  outside this. Non-GET requests are rejected wholesale when
	 *  this is set. */
	shareViewer?: {
		from: string;
		to: string;
	};
}

export interface MeResponse extends UserSession {
	fitbitLinked: boolean;
}

// Fitbit API response types (not stored directly)
export interface FitbitTokenPair {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	token_type: string;
	user_id: string;
	scope: string;
}

export interface FitbitDevice {
	id: string;
	deviceVersion: string;
	type: string;
	/** Coarse battery state: "High" | "Medium" | "Low" | "Empty". */
	battery: string;
	/** Battery charge as an integer percent (0–100). Newer Fitbit field;
	 *  present for hardware trackers (the Inspire 3), absent on some
	 *  device types — hence optional. */
	batteryLevel?: number;
	lastSyncTime: string;
}
