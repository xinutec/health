import { Component, type OnDestroy, type OnInit, computed, effect, inject, resource, signal, ChangeDetectionStrategy } from "@angular/core";
import { DecimalPipe, KeyValuePipe } from "@angular/common";
import { ActivatedRoute, Router } from "@angular/router";
import { Subscription } from "rxjs";
import { MatButtonModule } from "@angular/material/button";
import { MatButtonToggleModule } from "@angular/material/button-toggle";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatTabsModule } from "@angular/material/tabs";
import { FormsModule } from "@angular/forms";
import {
	type ActivityDay,
	type BodyDay,
	HealthService,
	type HeartRatePoint,
	type HrvDay,
	type LatestFix,
	type TrackTailPoint,
	type SleepLog,
	type SleepStage,
	type VelocityData,
} from "../../services/health.service";
import { browserTimezone, formatDateInTz, todayLocal } from "../../time-utils";

/** How often to poll for the latest PhoneTrack fix while today's Map
 *  tab is open. */
const LIVE_POLL_MS = 15_000;

/** localStorage key for the last live fix — lets the Map tab show a
 *  position immediately after a reload, before the first poll. */
const LIVE_FIX_CACHE_KEY = "health:live-fix";

/** Default Trends-tab window. Matches the backend `daysParam` default
 *  and is the value omitted from the URL for a clean default link. */
const DEFAULT_TREND_DAYS = 30;
/** Trends-window bounds. The backend caps `days` at 365; mirror it here
 *  so the custom-number input cannot request a window the API rejects. */
const MIN_TREND_DAYS = 1;
const MAX_TREND_DAYS = 365;
/** Quick-pick presets for the Trends window toggle. */
export const TREND_DAY_PRESETS = [7, 30, 90, 365] as const;
import { logBootContext } from "../../client-diagnostics";
import { BatteryChartComponent } from "../battery-chart/battery-chart.component";
import { DayNavComponent } from "../day-nav/day-nav.component";
import { PullToRefreshComponent } from "../pull-to-refresh/pull-to-refresh.component";
import { HeartrateChartComponent } from "../heartrate-chart/heartrate-chart.component";
import { HrvChartComponent } from "../hrv-chart/hrv-chart.component";
import { HypnogramComponent } from "../hypnogram/hypnogram.component";
import { IntradayHrComponent } from "../intraday-hr/intraday-hr.component";
import { MapComponent } from "../map/map.component";
import { SleepChartComponent } from "../sleep-chart/sleep-chart.component";
import { SpeedChartComponent } from "../speed-chart/speed-chart.component";
import { StepsChartComponent } from "../steps-chart/steps-chart.component";
import { SummaryCardsComponent } from "../summary-cards/summary-cards.component";
import { TimelineComponent } from "../timeline/timeline.component";
import { WeightChartComponent } from "../weight-chart/weight-chart.component";
import { selectDayActivity, selectDayMainSleep } from "./day-selection";

/** Per-day payload — the data that changes when you navigate days. */
interface DayData {
	stages: SleepStage[];
	hr: HeartRatePoint[];
	velocity: VelocityData | null;
}

/** Rolling-window payload — the last 30 days of activity + sleep + HRV.
 *  Does NOT depend on the selected day, so it is fetched once and the
 *  selected day is derived from it. */
interface WindowData {
	activity: ActivityDay[];
	sleep: SleepLog[];
	hrv: HrvDay[];
	body: BodyDay[];
}

/** Client-side fetch durations (ms) for the performance panel. */
export interface LoadTimings {
	window?: { activity: number; sleep: number; hrv: number; body: number; total: number };
	day?: { stages: number; hr: number; velocity: number; total: number };
}

/**
 * Day + Trends + Map tabs. Used by both `/` (owner) and `/share/:token`
 * (recipient) — the only difference is the route param.
 *
 * # State model
 *
 * The selected day is the single source of truth (`selectedDate`). Two
 * `resource()`s derive from it and the auth state:
 *
 *   - `windowData` (activity + sleep, last 30 days) loads once the user
 *     is ready; it is day-independent, so navigation never refetches it.
 *   - `dayData` (sleep stages, intraday HR, velocity) is keyed on
 *     `selectedDate`. When the day changes, the resource supersedes any
 *     in-flight load — aborting it on the wire — and only ever applies
 *     the latest day's result. This is what makes a fast burst of
 *     day-navigation settle on the landed-on day with no stale flash and
 *     no manual race-guarding.
 *
 * Everything the template binds (`velocity()`, `latestSleep()`,
 * `dayLoading()`, …) is a `computed()` over those resources, so view
 * state cannot desync from the data it describes.
 *
 * # URL
 *
 * `selectedDate` / `view` are reflected into `?date=` / `?tab=` by the
 * navigation handlers, and adopted back from the URL on first paint and
 * on browser back/forward. Share mode (`share/:token`) stashes the token
 * on `HealthService` so every API call carries `X-Share-Token`; the
 * server gates read-only + date-window.
 */
@Component({
	selector: "app-dashboard",
	standalone: true,
	imports: [
		DecimalPipe,
		KeyValuePipe,
		FormsModule,
		MatButtonModule,
		MatButtonToggleModule,
		MatFormFieldModule,
		MatInputModule,
		MatProgressSpinnerModule,
		MatTabsModule,
		PullToRefreshComponent,
		DayNavComponent,
		SummaryCardsComponent,
		HypnogramComponent,
		IntradayHrComponent,
		SpeedChartComponent,
		BatteryChartComponent,
		TimelineComponent,
		MapComponent,
		StepsChartComponent,
		HeartrateChartComponent,
		HrvChartComponent,
		SleepChartComponent,
		WeightChartComponent,
	],
	templateUrl: "./dashboard.component.html",
	changeDetection: ChangeDetectionStrategy.OnPush,
	styleUrl: "./dashboard.component.scss",
})
export class DashboardComponent implements OnInit, OnDestroy {
	readonly view = signal<"today" | "trends" | "map">("today");
	/** Tab index for `<mat-tab-group [selectedIndex]>`, derived from `view`. */
	readonly tabIndex = computed(() => (this.view() === "today" ? 0 : this.view() === "trends" ? 1 : 2));
	readonly selectedDate = signal(todayLocal());
	/** Map toggle: snap walking legs onto the pavement network (pedestrian
	 *  map-matching). Off renders the raw walks, for an A/B comparison. Drives
	 *  `dayData`, so toggling refetches the velocity. */
	readonly walkMatch = signal(true);
	/** How many days of history the Trends tab charts span. Reflected
	 *  into `?trendDays=N`; the default (30) is omitted for a clean URL.
	 *  Drives the `windowData` resource, so changing it refetches. */
	readonly trendDays = signal(DEFAULT_TREND_DAYS);

	// Auth / linkage gates. `dataReady` flips true once we know the user
	// is signed in with a linked Fitbit — only then do the resources load.
	readonly authReady = signal(false);
	readonly authenticated = signal(false);
	readonly fitbitLinked = signal(false);
	private readonly dataReady = computed(() => this.authenticated() && this.fitbitLinked());

	readonly health = inject(HealthService);
	private readonly route = inject(ActivatedRoute);
	private readonly router = inject(Router);
	private querySub: Subscription | null = null;

	/** True iff this dashboard instance is rendering a share URL.
	 *  Set in ngOnInit from the route's `:token` param. */
	private isShareView = false;

	/** Recorded fetch durations for the performance panel. */
	readonly timings = signal<LoadTimings>({});

	/** Activity + sleep + HRV over the Trends window. Day-independent but
	 *  keyed on `trendDays`, so it loads once per session at the default
	 *  span and refetches only when the user changes the Trends range —
	 *  never on day-navigation. */
	private readonly windowData = resource<WindowData, number | undefined>({
		// `undefined` keeps the resource idle until the user is ready; the
		// `trendDays` key thereafter means it reloads only when the span
		// changes.
		params: () => (this.dataReady() ? this.trendDays() : undefined),
		defaultValue: { activity: [], sleep: [], hrv: [], body: [] },
		loader: async ({ params: days, abortSignal }) => {
			const t0 = performance.now();
			const timed = <T>(p: Promise<T>): Promise<[T, number]> => {
				const start = performance.now();
				return p.then((v) => [v, performance.now() - start] as [T, number]);
			};
			const [[activity, tActivity], [sleep, tSleep], [hrv, tHrv], [body, tBody]] = await Promise.all([
				timed(this.health.getActivity(days, abortSignal).catch(() => [] as ActivityDay[])),
				timed(this.health.getSleep(days, abortSignal).catch(() => [] as SleepLog[])),
				timed(this.health.getHrv(days, abortSignal).catch(() => [] as HrvDay[])),
				timed(this.health.getBody(days, abortSignal).catch(() => [] as BodyDay[])),
			]);
			this.timings.update((t) => ({
				...t,
				window: { activity: tActivity, sleep: tSleep, hrv: tHrv, body: tBody, total: performance.now() - t0 },
			}));
			return { activity, sleep, hrv, body };
		},
	});

	/** The selected day's stages / intraday HR / velocity. Keyed on the
	 *  day, so it reloads — and supersedes — on navigation. `undefined`
	 *  params keep it idle until the user is ready. */
	private readonly dayData = resource<DayData, { date: string; walkMatch: boolean } | undefined>({
		params: () => (this.dataReady() ? { date: this.selectedDate(), walkMatch: this.walkMatch() } : undefined),
		defaultValue: { stages: [], hr: [], velocity: null },
		loader: async ({ params: { date, walkMatch }, abortSignal }) => {
			const t0 = performance.now();
			// A fresh load for this day: clear any prior velocity failure so a
			// retry (or a navigation to a healthy day) drops the error banner.
			this.velocityFailed.set(false);
			const timed = <T>(p: Promise<T>): Promise<[T, number]> => {
				const start = performance.now();
				return p.then((v) => [v, performance.now() - start] as [T, number]);
			};
			const [[stages, tStages], [hr, tHr], [velocity, tVelocity]] = await Promise.all([
				timed(this.health.getSleepStages(date, abortSignal).catch(() => [] as SleepStage[])),
				timed(this.health.getHeartRateIntraday(date, abortSignal).catch(() => [] as HeartRatePoint[])),
				timed(
					this.health.getVelocity(date, abortSignal, walkMatch).catch((e: unknown) => {
						// Distinguish a genuine load failure from an empty day so the
						// view can offer a retry instead of silently rendering "no
						// data". An aborted request (superseded day-navigation) is not
						// a failure — it is expected and self-corrects.
						if (!(e instanceof DOMException && e.name === "AbortError")) this.velocityFailed.set(true);
						return null;
					}),
				),
			]);
			this.timings.update((t) => ({
				...t,
				day: { stages: tStages, hr: tHr, velocity: tVelocity, total: performance.now() - t0 },
			}));
			return { stages, hr, velocity };
		},
	});

	/** Latches once the first day-load resolves. A day-navigation changes
	 *  the resource's `params`, which Angular reports as `loading` (the
	 *  same status as the very first load) — so status alone can't tell
	 *  "booting" from "navigating". This flag does: the full-screen boot
	 *  spinner shows only while it is false. Set in a constructor effect. */
	private readonly hasLoadedOnce = signal(false);
	/** The last successfully-resolved day payload. On a navigation load the
	 *  resource's `value()` resets to the default (empty), so the view
	 *  reads through this snapshot to keep the previous day's content on
	 *  screen — dimmed by `.stale` — until the new day lands, instead of
	 *  blanking it. Updated in the same constructor effect. */
	private readonly lastDay = signal<DayData>({ stages: [], hr: [], velocity: null });
	/** The day payload to render: the resolved value, or the last good one
	 *  while a new day loads. */
	private readonly displayedDay = computed(() =>
		this.dayData.status() === "resolved" ? this.dayData.value() : this.lastDay(),
	);

	// ─── Derived view state (never set imperatively) ────────────────
	readonly activity = computed(() => this.windowData.value().activity);
	readonly sleep = computed(() => this.windowData.value().sleep);
	readonly hrv = computed(() => this.windowData.value().hrv);
	readonly body = computed(() => this.windowData.value().body);
	readonly sleepStages = computed(() => this.displayedDay().stages);
	readonly intradayHr = computed(() => this.displayedDay().hr);
	readonly velocity = computed(() => this.displayedDay().velocity);

	/** Set when a velocity load rejected (network/server error), cleared at
	 *  the start of each load. Lets the view tell "this day's location data
	 *  failed to load" (offer a retry) from "this day genuinely has no
	 *  location data" (the empty-state message). */
	private readonly velocityFailed = signal(false);
	/** Show the velocity error+retry affordance only when a load has failed
	 *  AND we are not mid-load — during a (re)load the spinner overlay owns
	 *  the screen, and a stale previous day still shows underneath. */
	readonly velocityError = computed(() => this.velocityFailed() && !this.dayLoading());
	readonly latestActivity = computed(() => selectDayActivity(this.activity(), this.selectedDate()));
	readonly latestSleep = computed(() => selectDayMainSleep(this.sleep(), this.selectedDate()));

	/** In-body overlay + dim: a day's data is loading (first time or on
	 *  navigation). This is the spinner the user sees while stepping days. */
	readonly dayLoading = computed(() => this.dayData.isLoading());
	/** Any data resource in flight — drives the pull-to-refresh spinner so it
	 *  holds until the reload settles. */
	readonly dataLoading = computed(() => this.dayData.isLoading() || this.windowData.isLoading());
	/** True while a pull-to-refresh is showing its own spinner — used to hide
	 *  the in-body day-loading overlays so the gesture shows just one spinner. */
	readonly pullRefreshing = signal(false);

	/** Pull-to-refresh handler: refetch the data behind the current view. The
	 *  day resource backs Day + Map + summary; the Trends tab also reads the
	 *  multi-day window, so reload that too when it's showing. */
	reloadCurrent(): void {
		this.dayData.reload();
		if (this.view() === "trends") this.windowData.reload();
	}

	/** Full-screen boot spinner: shown only before the dashboard first has
	 *  any data — auth still resolving, or the first day-load hasn't
	 *  returned. Once data has loaded once, navigation uses `dayLoading`
	 *  (the in-body overlay), never this. */
	readonly loading = computed(() => {
		if (!this.authReady()) return true;
		if (!this.authenticated() || !this.fitbitLinked()) return false;
		return !this.hasLoadedOnce() && this.dayData.isLoading();
	});

	/** Most recent PhoneTrack fix — drives the Map tab's live marker.
	 *  Owned here, not in MapComponent, so it survives the Map tab
	 *  being torn down and rebuilt on each visit. */
	readonly liveFix = signal<LatestFix | null>(null);
	/** Raw PhoneTrack points recorded after the classified track ends — the Map
	 *  tab draws these so the live tail follows the real path, not a straight
	 *  line to the marker. Polled alongside `liveFix`. */
	readonly liveTail = signal<TrackTailPoint[]>([]);
	/** The date whose data is actually on screen — advances to `selectedDate`
	 *  only once that day's resource resolves. The map keys its auto-fit on this
	 *  (not the data object), so a same-day refetch (walk-snap toggle, refresh)
	 *  preserves the viewer's pan/zoom while a real day change re-fits. */
	readonly displayedDate = signal<string>("");

	constructor() {
		// Seed the live marker from the last cached fix so the Map tab
		// shows a position immediately on load — before the first poll
		// returns — rather than snapping in from the path's end.
		const cached = this.readCachedFix();
		if (cached) this.liveFix.set(cached);

		// Latch first-load and remember the last resolved day. This is what
		// lets the full-screen boot spinner fire only once, and keeps the
		// previous day's content on screen (dimmed) during a navigation
		// reload instead of blanking it. See hasLoadedOnce / lastDay.
		effect(() => {
			if (this.dayData.status() === "resolved") {
				this.lastDay.set(this.dayData.value());
				this.hasLoadedOnce.set(true);
				// The resolved value is for the current request key (selectedDate),
				// so this is the date now on screen. Drives the map's fit key.
				this.displayedDate.set(this.selectedDate());
			}
		});

		// Poll for the latest PhoneTrack fix while today's Map tab is
		// open. This lives on the dashboard, not MapComponent: the Map
		// tab is lazily (re)created on every visit, so holding the fix
		// here is what stops it resetting — and flickering — on each
		// tab switch.
		effect((onCleanup) => {
			if (!this.isToday()) {
				// A past day has no live marker or tail.
				this.liveFix.set(null);
				this.liveTail.set([]);
				return;
			}
			// Off the Map tab: keep the last fix, just stop polling.
			if (this.view() !== "map") return;
			const poll = (): void => {
				void this.health.getLatestFix().then((f) => {
					this.liveFix.set(f);
					if (f) this.cacheLiveFix(f);
				});
				// Raw tail since the end of the classified track (the last
				// computed fix), so the live path follows the real recent route.
				// Fall back to "no tail" (a far-future cutoff) rather than the whole
				// day if the classified end is unknown.
				const since = this.velocity()?.rawFixes?.at(-1)?.ts ?? Number.MAX_SAFE_INTEGER;
				void this.health.getLocationTail(since).then((tail) => this.liveTail.set(tail));
			};
			poll();
			const id = setInterval(poll, LIVE_POLL_MS);
			onCleanup(() => clearInterval(id));
		});
	}

	/** Read the last live fix from localStorage. Honoured only when it
	 *  is from today — the live marker is a "today" concept, and a
	 *  stale fix shown with just a time-of-day would mislead. */
	private readCachedFix(): LatestFix | null {
		try {
			const raw = localStorage.getItem(LIVE_FIX_CACHE_KEY);
			if (raw === null) return null;
			const f = JSON.parse(raw) as LatestFix;
			if (typeof f?.lat !== "number" || typeof f?.lon !== "number" || typeof f?.ts !== "number") {
				return null;
			}
			if (formatDateInTz(new Date(f.ts * 1000), browserTimezone()) !== todayLocal()) return null;
			return f;
		} catch {
			return null;
		}
	}

	/** Persist the latest fix so a reload can seed the marker before
	 *  the first poll. Silent if localStorage is unavailable. */
	private cacheLiveFix(f: LatestFix): void {
		try {
			localStorage.setItem(LIVE_FIX_CACHE_KEY, JSON.stringify(f));
		} catch {
			// localStorage disabled (private mode) — in-memory state
			// still works; only cross-reload memory is lost.
		}
	}

	/** Validate a `?date=YYYY-MM-DD` query parameter. Rejects
	 *  malformed strings and future dates (the timeline never
	 *  renders future days). */
	private parseDateParam(raw: string | null): string | null {
		if (raw === null) return null;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
		if (raw > todayLocal()) return null;
		return raw;
	}

	/** Validate a `?tab=` query parameter. Null (absent or junk) lets
	 *  the caller fall back to the default tab. */
	private parseTabParam(raw: string | null): "today" | "trends" | "map" | null {
		return raw === "today" || raw === "trends" || raw === "map" ? raw : null;
	}

	/** Validate a `?trendDays=N` query parameter. Returns null for absent
	 *  or non-integer input so the caller falls back to the default; a
	 *  valid integer is clamped into [MIN, MAX] to match the backend cap. */
	private parseTrendDaysParam(raw: string | null): number | null {
		if (raw === null) return null;
		if (!/^\d+$/.test(raw)) return null;
		const n = Number(raw);
		if (n < MIN_TREND_DAYS) return MIN_TREND_DAYS;
		if (n > MAX_TREND_DAYS) return MAX_TREND_DAYS;
		return n;
	}

	async ngOnInit(): Promise<void> {
		// Share mode: stash the route's `:token` param onto HealthService
		// so every API call carries `X-Share-Token`. The rest of the
		// dashboard runs identically; server-side gates enforce
		// read-only + date-window.
		const token = this.route.snapshot.paramMap.get("token");
		if (token) {
			this.isShareView = true;
			this.health.shareToken.set(token);
		}

		const ok = await this.health.checkAuth();
		this.authenticated.set(ok);

		if (ok) {
			// One-shot boot context (UA, viewport, tz, locale) for future
			// bug-correlation. Owner mode only — share-viewer's POST would
			// 403 and the diagnostics are about the OWNER's environment.
			if (!this.isShareView) logBootContext(this.health);

			this.fitbitLinked.set(this.health.user()?.fitbitLinked ?? false);

			if (this.fitbitLinked()) {
				// Restore day + tab from the URL on first paint so reload —
				// and share links like `/share/<token>?tab=map` — open on
				// the right day and tab. Setting these before the data
				// resources first run means a single load for the right day.
				const initial = this.parseDateParam(this.route.snapshot.queryParamMap.get("date"));
				if (initial !== null) this.selectedDate.set(initial);
				const initialTab = this.parseTabParam(this.route.snapshot.queryParamMap.get("tab"));
				if (initialTab !== null) this.view.set(initialTab);
				const initialDays = this.parseTrendDaysParam(this.route.snapshot.queryParamMap.get("trendDays"));
				if (initialDays !== null) this.trendDays.set(initialDays);

				// Adopt query-param changes the app did not initiate itself:
				// browser back/forward and direct URL edits. Navigation the
				// app triggers updates the signals first, so the equality
				// guards below make this a no-op for those.
				this.querySub = this.route.queryParamMap.subscribe((params) => {
					const tab = this.parseTabParam(params.get("tab"));
					if (tab !== null && tab !== this.view()) this.view.set(tab);
					const next = this.parseDateParam(params.get("date")) ?? todayLocal();
					if (next !== this.selectedDate()) this.selectedDate.set(next);
					const days = this.parseTrendDaysParam(params.get("trendDays")) ?? DEFAULT_TREND_DAYS;
					if (days !== this.trendDays()) this.trendDays.set(days);
				});

				// Fire-and-forget: keep PhoneTrack's visualisation filter
				// aligned with "today from 00:00 (or yesterday after
				// midnight before 06:00)". Skip in share mode — the backend
				// 403s, and the recipient has no business touching the
				// owner's PhoneTrack prefs.
				if (!this.isShareView) void this.health.syncPhoneTrackFilter();
			}
		}

		// Data now flows reactively from the resources — no explicit load.
		this.authReady.set(true);
	}

	ngOnDestroy(): void {
		this.querySub?.unsubscribe();
	}

	/** Step the selected day by `delta`. Applies the step to state
	 *  synchronously — so a fast burst of clicks each computes from the
	 *  correct day, not a stale one — then reflects it into `?date=`.
	 *  The `dayData` resource reloads off `selectedDate` and supersedes
	 *  any in-flight load, so only the landed-on day's data is shown. */
	changeDay(delta: number): void {
		const d = new Date(`${this.selectedDate()}T12:00:00`); // noon to avoid DST edge
		d.setDate(d.getDate() + delta);
		const newDate = formatDateInTz(d, browserTimezone());
		if (newDate > this.rightEdge()) return;
		const left = this.leftEdge();
		if (left !== null && newDate < left) return;
		if (newDate === this.selectedDate()) return;
		this.selectedDate.set(newDate);
		// Reflect into the URL (relativeTo keeps `/` or `/share/<token>`
		// and only rewrites the query string). The queryParamMap
		// subscription then sees selectedDate already at newDate and
		// skips a redundant set.
		const queryParams = newDate === todayLocal() ? { date: null } : { date: newDate };
		void this.router.navigate([], {
			relativeTo: this.route,
			queryParams,
			queryParamsHandling: "merge",
		});
	}

	/** Re-run the current day's load. Bound to the velocity error-state
	 *  retry button — a transient backend hiccup (or a slow first compute)
	 *  no longer leaves the day stuck looking empty. */
	retryDay(): void {
		this.dayData.reload();
	}

	/** Switch tabs and mirror the choice into `?tab=` so reload and
	 *  share links keep it. "today" is the default — omitted for a
	 *  clean URL, same as `?date=` omits the current day. */
	changeTab(index: number): void {
		const tab = index === 0 ? "today" : index === 1 ? "trends" : "map";
		this.view.set(tab);
		void this.router.navigate([], {
			relativeTo: this.route,
			queryParams: { tab: tab === "today" ? null : tab },
			queryParamsHandling: "merge",
		});
	}

	/** Set the Trends-tab window, clamped to the backend-supported range,
	 *  and mirror it into `?trendDays=N`. The default (30) is omitted for
	 *  a clean URL — same convention as `?date=` / `?tab=`. The
	 *  `windowData` resource is keyed on `trendDays`, so this triggers a
	 *  single refetch at the new span. Ignores a no-op (same value) so a
	 *  duplicate toggle/blur doesn't push a redundant history entry. */
	setTrendDays(n: number): void {
		const clamped = !Number.isFinite(n)
			? DEFAULT_TREND_DAYS
			: Math.min(MAX_TREND_DAYS, Math.max(MIN_TREND_DAYS, Math.round(n)));
		if (clamped === this.trendDays()) return;
		this.trendDays.set(clamped);
		void this.router.navigate([], {
			relativeTo: this.route,
			queryParams: { trendDays: clamped === DEFAULT_TREND_DAYS ? null : clamped },
			queryParamsHandling: "merge",
		});
	}

	/** The preset windows offered by the Trends range toggle. */
	readonly trendPresets = TREND_DAY_PRESETS;

	isToday(): boolean {
		return this.selectedDate() === todayLocal();
	}

	/** Earliest navigable date. Owner mode: null (no limit). Share
	 *  mode: shareWindow.from. */
	leftEdge(): string | null {
		return this.health.user()?.shareWindow?.from ?? null;
	}

	/** Latest navigable date. Owner mode: today. Share mode:
	 *  min(today, shareWindow.to). */
	rightEdge(): string {
		const win = this.health.user()?.shareWindow;
		const t = todayLocal();
		if (!win) return t;
		return win.to < t ? win.to : t;
	}

	canGoLeft(): boolean {
		const left = this.leftEdge();
		return left === null || this.selectedDate() > left;
	}

	canGoRight(): boolean {
		return this.selectedDate() < this.rightEdge();
	}

	formatDisplayDate(): string {
		const date = this.selectedDate();
		if (date === todayLocal()) return "Today";
		const d = new Date(`${date}T12:00:00`);
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		if (date === formatDateInTz(yesterday, browserTimezone())) return "Yesterday";
		return d.toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" });
	}
}
