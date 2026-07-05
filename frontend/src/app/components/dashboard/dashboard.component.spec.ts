import { type ComponentFixture, TestBed } from "@angular/core/testing";
import { signal } from "@angular/core";
import { provideRouter, Router } from "@angular/router";
import { beforeEach, describe, expect, it } from "vitest";
import { type ActivityDay, HealthService, type SleepLog, type VelocityData } from "../../services/health.service";
import { todayLocal } from "../../time-utils";
import { DashboardComponent } from "./dashboard.component";

function activity(date: string, steps = 5000): ActivityDay {
	return {
		date,
		steps,
		calories_total: 2000,
		calories_active: 500,
		distance_km: 4,
		minutes_sedentary: 600,
		minutes_lightly_active: 100,
		minutes_fairly_active: 20,
		minutes_very_active: 30,
		resting_heart_rate: 60,
	} as ActivityDay;
}

function mainSleep(date: string, minutes = 489): SleepLog {
	return {
		log_id: "1",
		date,
		start_time: `${date}T22:00:00`,
		end_time: `${date}T06:00:00`,
		duration_ms: minutes * 60_000,
		efficiency: 90,
		minutes_asleep: minutes,
		minutes_awake: 10,
		minutes_deep: 90,
		minutes_light: 250,
		minutes_rem: 100,
		minutes_wake: 30,
		is_main_sleep: true,
	} as SleepLog;
}

/** A promise whose resolution the test triggers by hand — lets a test
 *  interleave the overlapping day-loads a fast burst of navigation
 *  produces, deterministically. */
interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}
function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (reason?: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

interface HealthMock {
	health: HealthService;
	/** Per-date deferred velocity loads, so the test controls completion order. */
	pending: Map<string, Deferred<VelocityData>>;
	/** Every `days` value the window resource asked `getActivity` for, in
	 *  order — lets a test assert the Trends control refetches at the new
	 *  span. */
	activityDaysSeen: number[];
}

/** A complete enough HealthService stand-in to run ngOnInit cleanly: a
 *  signed-in, Fitbit-linked owner. `getVelocity` is deferred per date so
 *  a test can resolve day-loads in any order; everything else resolves
 *  immediately. */
function makeHealthMock(opts: { activity?: ActivityDay[]; sleep?: SleepLog[] } = {}): HealthMock {
	const pending = new Map<string, Deferred<VelocityData>>();
	const activityDaysSeen: number[] = [];
	const health = {
		user: signal({ fitbitLinked: true }),
		shareToken: signal(null),
		checkAuth: async () => true,
		clientLog: async () => {},
		syncPhoneTrackFilter: async () => {},
		getLatestFix: async () => null,
		getActivity: async (days: number) => {
			activityDaysSeen.push(days);
			return opts.activity ?? [];
		},
		getSleep: async () => opts.sleep ?? [],
		getHrv: async () => [],
		getBody: async () => [],
		getSleepStages: async () => [],
		getHeartRateIntraday: async () => [],
		getVelocity: (date: string) => {
			const d = deferred<VelocityData>();
			pending.set(date, d);
			return d.promise;
		},
	} as unknown as HealthService;
	return { health, pending, activityDaysSeen };
}

const vel = (): VelocityData => ({ points: [], segments: [] }) as unknown as VelocityData;

function setup(mock: HealthMock): ComponentFixture<DashboardComponent> {
	TestBed.configureTestingModule({
		imports: [DashboardComponent],
		providers: [provideRouter([{ path: "**", children: [] }]), { provide: HealthService, useValue: mock.health }],
	});
	return TestBed.createComponent(DashboardComponent);
}

/** Pump change detection + the microtask queue so ngOnInit's auth flow
 *  settles and the resource scheduler runs its loaders. */
async function pump(fixture: ComponentFixture<unknown>): Promise<void> {
	fixture.detectChanges();
	await new Promise((r) => setTimeout(r));
	fixture.detectChanges();
}

/** Run ngOnInit to completion: auth resolves, the user is ready, and the
 *  window + first day resources have started. Leaves the default-day
 *  (today) velocity load pending. */
async function boot(fixture: ComponentFixture<unknown>): Promise<void> {
	await pump(fixture);
	await pump(fixture);
}

describe("DashboardComponent — selected-day summary cards", () => {
	beforeEach(() => TestBed.resetTestingModule());

	it("shows the selected day's activity and sleep, not yesterday's", async () => {
		const today = "2026-05-10";
		const mock = makeHealthMock({
			activity: [activity("2026-05-09"), activity(today, 8000)],
			sleep: [mainSleep("2026-05-09"), mainSleep(today, 480)],
		});
		const fixture = setup(mock);
		const cmp = fixture.componentInstance;
		await boot(fixture);

		cmp.selectedDate.set(today);
		await pump(fixture);

		expect(cmp.latestActivity()?.steps).toBe(8000);
		expect(cmp.latestSleep()?.minutes_asleep).toBe(480);
	});

	it("does NOT show yesterday's sleep when today has none synced yet", async () => {
		const today = "2026-05-10";
		const mock = makeHealthMock({
			activity: [activity("2026-05-09"), activity(today, 8000)],
			sleep: [mainSleep("2026-05-09")], // only yesterday's sleep synced
		});
		const fixture = setup(mock);
		const cmp = fixture.componentInstance;
		await boot(fixture);

		cmp.selectedDate.set(today);
		await pump(fixture);

		expect(cmp.latestSleep()).toBeNull();
		expect(cmp.latestActivity()?.date).toBe(today);
	});
});

describe("DashboardComponent — concurrent day navigation", () => {
	beforeEach(() => TestBed.resetTestingModule());

	it("steps one day per changeDay call in a fast synchronous burst", () => {
		const cmp = setup(makeHealthMock()).componentInstance;
		cmp.selectedDate.set("2026-05-14");
		cmp.changeDay(-1);
		cmp.changeDay(-1);
		cmp.changeDay(-1);
		cmp.changeDay(-1);
		expect(cmp.selectedDate()).toBe("2026-05-10");
	});

	it("shows only the landed-on day's velocity when an earlier day's load resolves last", async () => {
		const mock = makeHealthMock();
		const fixture = setup(mock);
		const cmp = fixture.componentInstance;
		await boot(fixture);

		cmp.selectedDate.set("2026-05-14");
		await pump(fixture); // load starts for 2026-05-14
		cmp.selectedDate.set("2026-05-10");
		await pump(fixture); // load starts for 2026-05-10; the -14 load is superseded

		const velLanded = vel();
		// Out of order: the landed-on day returns first, the abandoned
		// older day's request returns last.
		mock.pending.get("2026-05-10")?.resolve(velLanded);
		mock.pending.get("2026-05-14")?.resolve(vel());
		await pump(fixture);

		expect(cmp.velocity()).toBe(velLanded);
	});

	it("a stale day's late result never overwrites the current day", async () => {
		const mock = makeHealthMock();
		const fixture = setup(mock);
		const cmp = fixture.componentInstance;
		await boot(fixture);

		cmp.selectedDate.set("2026-05-14");
		await pump(fixture);
		cmp.selectedDate.set("2026-05-10");
		await pump(fixture);

		// The day the user left resolves after they moved on; 2026-05-10
		// never resolves.
		mock.pending.get("2026-05-14")?.resolve(vel());
		await pump(fixture);

		// The stale 2026-05-14 payload was discarded; the current day's
		// default (null) still stands.
		expect(cmp.velocity()).toBeNull();
	});
});

describe("DashboardComponent — loading UX (rendered DOM)", () => {
	beforeEach(() => TestBed.resetTestingModule());

	const q = (fixture: ComponentFixture<unknown>, sel: string): Element | null =>
		(fixture.nativeElement as HTMLElement).querySelector(sel);

	it("first paint shows the full-screen boot spinner, not the tabs", async () => {
		const mock = makeHealthMock();
		const fixture = setup(mock);
		await boot(fixture); // auth resolved, first day's velocity still pending
		expect(q(fixture, ".app-loading"), "boot spinner present").toBeTruthy();
		expect(q(fixture, ".view-tabs"), "tabs hidden until first day loads").toBeFalsy();
	});

	it("after the first day loads, the tabs render and nothing is stale", async () => {
		const mock = makeHealthMock();
		const fixture = setup(mock);
		await boot(fixture);
		mock.pending.get(todayLocal())?.resolve(vel());
		await pump(fixture);

		expect(q(fixture, ".app-loading"), "boot spinner gone").toBeFalsy();
		expect(q(fixture, ".view-tabs"), "tabs visible").toBeTruthy();
		expect(q(fixture, ".day-body.stale"), "not stale once loaded").toBeFalsy();
	});

	it("day-navigation dims the body with an overlay — never a full-screen reset", async () => {
		const mock = makeHealthMock();
		const fixture = setup(mock);
		const cmp = fixture.componentInstance;
		await boot(fixture);
		mock.pending.get(todayLocal())?.resolve(vel());
		await pump(fixture);

		cmp.changeDay(-1); // navigate; the new day's velocity is now pending
		await pump(fixture);

		// The regression guard for the redesign: a reload keeps the tabs and
		// the (dimmed) previous content with an in-body overlay — it must NOT
		// fall back to the full-screen boot spinner or blank the page.
		expect(q(fixture, ".app-loading"), "no full-screen reset on day-nav").toBeFalsy();
		expect(q(fixture, ".view-tabs"), "tabs stay mounted").toBeTruthy();
		expect(q(fixture, ".day-body.stale"), "body dimmed during reload").toBeTruthy();
		expect(q(fixture, ".day-body-overlay"), "overlay spinner shown").toBeTruthy();

		// The landed-on day resolves → un-stale, overlay gone.
		mock.pending.get(cmp.selectedDate())?.resolve(vel());
		await pump(fixture);
		expect(q(fixture, ".day-body.stale"), "un-stale after load").toBeFalsy();
		expect(q(fixture, ".day-body-overlay"), "overlay gone after load").toBeFalsy();
	});
});

describe("DashboardComponent — Trends window control", () => {
	beforeEach(() => TestBed.resetTestingModule());

	it("defaults to a 30-day window and fetches that span once", async () => {
		const mock = makeHealthMock();
		const fixture = setup(mock);
		const cmp = fixture.componentInstance;
		await boot(fixture);

		expect(cmp.trendDays()).toBe(30);
		expect(mock.activityDaysSeen).toEqual([30]);
	});

	it("setTrendDays refetches the window at the new span", async () => {
		const mock = makeHealthMock();
		const fixture = setup(mock);
		const cmp = fixture.componentInstance;
		await boot(fixture);

		cmp.setTrendDays(90);
		await pump(fixture);

		expect(cmp.trendDays()).toBe(90);
		expect(mock.activityDaysSeen).toEqual([30, 90]);
	});

	it("clamps out-of-range and fractional inputs to [1, 365] integers", async () => {
		const mock = makeHealthMock();
		const fixture = setup(mock);
		const cmp = fixture.componentInstance;
		await boot(fixture);

		cmp.setTrendDays(0);
		expect(cmp.trendDays()).toBe(1);
		cmp.setTrendDays(10_000);
		expect(cmp.trendDays()).toBe(365);
		cmp.setTrendDays(45.7);
		expect(cmp.trendDays()).toBe(46);
	});

	it("ignores a no-op set so it does not refetch or push history", async () => {
		const mock = makeHealthMock();
		const fixture = setup(mock);
		const cmp = fixture.componentInstance;
		await boot(fixture);

		cmp.setTrendDays(30); // already the default
		await pump(fixture);

		expect(mock.activityDaysSeen).toEqual([30]);
	});

	it("restores the window from a ?trendDays= query param on first paint", async () => {
		const mock = makeHealthMock();
		TestBed.configureTestingModule({
			imports: [DashboardComponent],
			providers: [
				provideRouter([{ path: "**", children: [] }]),
				{ provide: HealthService, useValue: mock.health },
			],
		});
		const router = TestBed.inject(Router);
		await router.navigate([], { queryParams: { trendDays: "90" } });
		const fixture = TestBed.createComponent(DashboardComponent);
		await boot(fixture);

		expect(fixture.componentInstance.trendDays()).toBe(90);
		expect(mock.activityDaysSeen).toEqual([90]);
	});
});

describe("DashboardComponent — velocity load failure", () => {
	beforeEach(() => TestBed.resetTestingModule());

	const q = (fixture: ComponentFixture<unknown>, sel: string): Element | null =>
		(fixture.nativeElement as HTMLElement).querySelector(sel);

	it("shows a retry affordance, not the empty state, when velocity fails to load", async () => {
		const mock = makeHealthMock();
		const fixture = setup(mock);
		const cmp = fixture.componentInstance;
		await boot(fixture);

		// The velocity request rejects (server/network error — not an abort).
		mock.pending.get(todayLocal())?.reject(new Error("backend error"));
		await pump(fixture);

		expect(cmp.velocityError(), "error state set on failure").toBe(true);
		expect(q(fixture, ".velocity-error"), "retry banner rendered").toBeTruthy();
		// The empty-state charts must not render in the error branch.
		expect(q(fixture, "app-timeline"), "timeline chart hidden under error").toBeFalsy();
	});

	it("clears the error and re-renders the day after a successful retry", async () => {
		const mock = makeHealthMock();
		const fixture = setup(mock);
		const cmp = fixture.componentInstance;
		await boot(fixture);
		mock.pending.get(todayLocal())?.reject(new Error("backend error"));
		await pump(fixture);
		expect(cmp.velocityError()).toBe(true);

		// Retry kicks off a fresh load; resolving it clears the error and
		// brings the charts back.
		cmp.retryDay();
		await pump(fixture);
		mock.pending.get(todayLocal())?.resolve(vel());
		await pump(fixture);

		expect(cmp.velocityError(), "error cleared after successful retry").toBe(false);
		expect(q(fixture, ".velocity-error"), "retry banner gone").toBeFalsy();
		expect(q(fixture, "app-timeline"), "timeline chart restored").toBeTruthy();
	});
});
