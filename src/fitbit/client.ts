/**
 * Thin Fitbit HTTP client. All token management lives in
 * `token-manager.ts`, which provides per-user refresh mutex and
 * typed reauth-required signalling. The client is constructed with
 * userId + OAuth config; rate-limit state stays here because it's a
 * per-process concern, not a per-user one.
 */

import { asFitbitSleepLogId } from "../db/branded.js";
import { decideRateLimitWait, MAX_INPROCESS_WAIT_MS, RateLimitExhaustedError } from "./rate-limit.js";
import { type FitbitOAuthConfig, getValidTokens } from "./token-manager.js";

export class FitbitClient {
	private rateLimitRemaining_ = 150;
	private rateLimitResetAt = 0;

	constructor(
		private readonly userId: string,
		private readonly config: FitbitOAuthConfig,
	) {}

	get rateLimitRemaining(): number {
		return this.rateLimitRemaining_;
	}

	async get<T>(path: string, retries = 0): Promise<T> {
		const tokens = await getValidTokens(this.userId, this.config);
		await this.waitForRateLimit();

		const url = path.startsWith("http") ? path : `https://api.fitbit.com${path}`;
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
		});

		this.updateRateLimit(res.headers);

		if (res.status === 429) {
			const waitSec = parseInt(res.headers.get("retry-after") ?? "3600", 10);
			// A real 429 means the budget is already spent. Ride out a short
			// retry-after in-process, but once we'd block past the in-process
			// cap (or after 3 tries) bail cleanly so the cron resumes next
			// tick rather than overrunning the job deadline.
			if (retries >= 3 || waitSec * 1000 > MAX_INPROCESS_WAIT_MS) {
				throw new RateLimitExhaustedError(waitSec);
			}
			console.log(`Rate limited, waiting ${waitSec}s (retry ${retries + 1}/3)`);
			await sleep(waitSec * 1000);
			return this.get<T>(path, retries + 1);
		}

		const text = await res.text();
		if (!res.ok) {
			throw new Error(`Fitbit API ${path}: ${res.status} ${text}`);
		}

		return parseFitbitJson(text) as T;
	}

	private async waitForRateLimit(): Promise<void> {
		const action = decideRateLimitWait(this.rateLimitRemaining_, this.rateLimitResetAt - Date.now());
		if (action.kind === "proceed") return;
		if (action.kind === "exhausted") throw new RateLimitExhaustedError(action.resumeInSec);
		console.log(`Rate limit low (${this.rateLimitRemaining_}), waiting ${Math.ceil(action.ms / 1000)}s`);
		await sleep(action.ms);
	}

	private updateRateLimit(headers: Headers): void {
		const remaining = headers.get("fitbit-rate-limit-remaining");
		const reset = headers.get("fitbit-rate-limit-reset");
		if (remaining !== null) this.rateLimitRemaining_ = parseInt(remaining, 10);
		if (reset !== null) this.rateLimitResetAt = Date.now() + parseInt(reset, 10) * 1000;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * JSON.parse that preserves precision on Fitbit's 64-bit `logId` values.
 *
 * Fitbit sleep log IDs are BIGINTs (~7e18), which exceed JS Number
 * precision (2^53 ≈ 9e15). Plain JSON.parse silently rounds them and
 * the same id then serialises differently in different mariadb
 * driver code paths, leaving sleep.log_id and sleep_stages.sleep_log_id
 * with non-equal values for the same logical record (and breaking
 * the /api/sleep/stages join).
 *
 * Approach: textually quote `"logId":<digits>` before parsing, then
 * use a reviver to promote the quoted strings to native BigInt.
 * Other numeric fields are untouched. The regex is unambiguous in
 * JSON because object keys are quoted strings.
 */
export function parseFitbitJson(text: string): unknown {
	const preserved = text.replace(/"logId":\s*(\d+)/g, '"logId":"$1"');
	return JSON.parse(preserved, (key, value) =>
		key === "logId" && typeof value === "string" ? asFitbitSleepLogId(BigInt(value)) : value,
	);
}
