/**
 * Owntracks Android → Nextcloud PhoneTrack proxy with server-side remote
 * configuration.
 *
 * The Android Owntracks app posts location updates over HTTP. Normally
 * this points directly at Nextcloud's PhoneTrack endpoint. Pointing it
 * at this proxy instead lets us:
 *
 *   1. Forward the payload to PhoneTrack unchanged (PhoneTrack remains
 *      the source of truth for location history — we don't duplicate
 *      storage here).
 *   2. Decide server-side whether to push remote-configuration commands
 *      back to the phone, using the much richer context we have:
 *      focus_places, mode signatures, daily activity rhythms.
 *
 * # Decision architecture
 *
 * Each Owntracks POST runs through one decision pipeline that turns the
 * recent fix history (plus the current fix's metadata) into a set of
 * named signals, then runs the signals past four explicit transition
 * predicates in priority order:
 *
 *   1. `escalateOnHighSpeed` — single-fix or computed velocity > 30 km/h
 *      flips us straight into transit/transit-fast. Fastest reaction
 *      when the user boards a vehicle. Doesn't depend on history.
 *   2. `escalateFromSignificant` — when the phone is in Significant
 *      ("energy saving") mode, motion evidence (closely-spaced fixes,
 *      user-action trigger, displacement above walking-pace) escalates
 *      us into a Move-mode profile. Refines to walking if history
 *      supports it; otherwise pushes a generic transit profile.
 *   3. `refineInMove` — when the phone is in Move mode and history is
 *      rich enough, pick the precise profile from effective speed and
 *      straightness (transit-fast / transit / walking).
 *   4. `demoteAfterStop` — only after 10 minutes of sustained
 *      low-speed history do we push the phone back to Significant.
 *      Single weird-zero fixes (tube tunnel, ping messages) get ignored.
 *
 * Every fix's response carries a `setConfiguration` cmd with the
 * current profile's config — the proxy is stateless from the phone's
 * point of view, and the phone applies an idempotent patch each time.
 * Bandwidth is negligible (~few hundred bytes per fix), the proxy
 * doesn't need an in-memory anti-flap timer, and a transient state
 * loss on either side recovers on the very next fix.
 *
 * # Owntracks monitoring modes
 *    0 = Manual    (no automatic reporting; user pushes a button)
 *    1 = Significant (~100m or motion-triggered; battery-efficient)
 *    2 = Move      (continuous fixes every N seconds; high fidelity)
 *
 * # Owntracks trigger types (`t` field)
 *    p = ping (heartbeat)         u = userAction (manual)
 *    c = circular geofence        t = timer (Android scheduled)
 *    b = beacon                   v = monitoring level changed
 *    r = reportLocation command
 *
 * See https://owntracks.org/booklet/tech/json/ for the full schema and
 * https://owntracks.org/booklet/features/remoteconfig/ for the command
 * protocol we use on the response path.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Config } from "../config.js";
import { db } from "../db/pool.js";
import type { AppEnv } from "../env.js";
import { haversineMeters } from "../geo/place-snap.js";
import { fetchTrackPoints, NextcloudNotLinkedError, NextcloudReauthRequiredError } from "../nextcloud/phonetrack.js";
import { getFocusPlacesForGating } from "./owntracks-focus-cache.js";
import { isLongStayLocation } from "./owntracks-long-stay.js";

/** Owntracks payloads are tiny — a typical batched fix is well under
 *  1 KB. Cap at 32 KB so a misconfigured client (or a hostile probe)
 *  can't OOM the proxy by streaming megabytes of body. */
const MAX_BODY_BYTES = 32 * 1024;

// ============================================================================
// Constants
// ============================================================================

const MIN_WALKING_FIXES = 3;
const WALKING_MIN_KMH = 2;
const WALKING_MAX_KMH = 8;
const WALKING_MIN_STRAIGHTNESS = 0.5;
const TRANSIT_KMH = 30;
const TRANSIT_FAST_KMH = 80;

/** How far back the walking / refinement window reaches. Long enough to
 *  gather Significant-mode fixes (which can wait minutes between fixes),
 *  short enough that yesterday's walk doesn't leak in. */
export const HISTORY_MAX_AGE_SEC = 600;

/** Minimum history span before in-Move refinement engages. A short burst
 *  of fixes right after escalation can't yet support a confident profile;
 *  wait for ~2 minutes of trajectory first. */
const MIN_HISTORY_SPAN_FOR_REFINE_SEC = 120;

/** Minimum history span before we'll demote to Significant. Demotion
 *  is the most expensive transition (phone gives up the warm GPS), so
 *  we require ~9 minutes of sustained low-speed evidence — cafe
 *  stops, office arrivals, evenings at home — before flipping.
 *
 *  MUST be strictly less than HISTORY_MAX_AGE_SEC: the pruner caps
 *  the history at HISTORY_MAX_AGE_SEC, so a threshold equal to (or
 *  greater than) that value is unreachable in practice — the span
 *  can never quite reach the prune ceiling because the oldest
 *  surviving fix has a timestamp >= now − HISTORY_MAX_AGE_SEC, and
 *  realistic fix timing leaves the oldest a few seconds into the
 *  window rather than at the boundary. Set 60s below the ceiling so
 *  the threshold is comfortably reachable. */
const MIN_STATIONARY_DEMOTE_SEC = 540;

/** How long a manual userAction ("push location" / "I want high-frequency
 *  now") pins the phone in Move mode by suppressing auto-demotion. The
 *  user is signalling they're about to do something; hold high frequency
 *  long enough to observe it (and catch a walk that starts moments later)
 *  before any demotion can resume on fresh evidence. 10 min. */
const MANUAL_OVERRIDE_HOLD_SEC = 600;

/** Gap threshold for the "phone's motion sensor fired" inference: in
 *  Significant mode, Owntracks Android schedules a fix roughly every
 *  15 minutes, and emits extras when motion is detected. Two fixes
 *  arriving < 5 minutes apart in Significant = real motion. */
const SIGNIFICANT_MODE_MOTION_GAP_SEC = 300;

// ============================================================================
// Types
// ============================================================================

export type MonitoringMode = 0 | 1 | 2;

/** Owntracks configuration patch. Partial — only fields we want to
 *  change. See https://owntracks.org/booklet/tech/json/ . */
export interface OwntracksConfigPatch {
	monitoring?: MonitoringMode;
	moveModeLocatorInterval?: number;
	locatorDisplacement?: number;
}

/** A coarse motion regime. `walking` is detected from a multi-fix
 *  history rather than a single velocity reading. */
export type MotionProfile = "transit-fast" | "transit" | "walking" | "stationary" | null;

/** A retained GPS fix. Extra fields (`vel`, `trigger`, `monitoringMode`)
 *  are optional so call sites that only have positional data can still
 *  build records — but production payloads from Owntracks Android
 *  carry all of them and the decision pipeline uses them. */
export interface FixRecord {
	ts: number; // unix seconds
	lat: number;
	lon: number;
	/** Velocity reported in the fix, km/h. Often null in Significant mode. */
	vel?: number | null;
	/** Owntracks `t` field — trigger type single char. */
	trigger?: string | null;
	/** Owntracks `m` field — current monitoring mode (1=Significant, 2=Move). */
	monitoringMode?: number | null;
}

/** All the signals derived from a fix history that the decision pipeline
 *  consumes. Each signal has well-defined semantics including how to
 *  interpret it when history is sparse. */
export interface DecisionSignals {
	/** Velocity reported in the latest fix (0 if missing). */
	reportedVelKmh: number;
	/** Velocity computed from displacement between the latest two fixes
	 *  (0 if only one fix). Robust to a missing `vel` field. */
	computedVelKmh: number;
	/** Time between the latest two fixes (0 if only one fix). */
	gapSinceLastFixSec: number;
	/** Effective speed across the whole history window (km/h). */
	effectiveSpeedKmh: number;
	/** Straightness ratio across the whole history window (0..1). */
	straightness: number;
	/** Time span covered by the history (seconds). */
	historySpanSec: number;
	/** Trigger type from the latest fix's `t` field. */
	trigger: string | null;
	/** Monitoring mode from the latest fix's `m` field. */
	monitoringMode: number | null;
}

/** Owntracks location-message payload shape (subset we care about). */
interface OwntracksLocation {
	_type?: string;
	vel?: number;
	lat?: number;
	lon?: number;
	acc?: number;
	tst?: number;
	t?: string;
	m?: number;
	/** Course over ground, degrees (0-359); Owntracks sends -1 / omits it when
	 *  the OS has no heading. The independent direction signal for PDR (#296). */
	cog?: number;
}

interface OwntracksCommand {
	_type: "cmd";
	action: "setConfiguration";
	configuration: {
		_type: "configuration";
	} & OwntracksConfigPatch;
}

// ============================================================================
// Pure geometry helpers
// ============================================================================

/**
 * Classify a single velocity reading into a coarse motion regime. Used as
 * the single-fix escalation signal. Returns null for the ambiguous
 * mid-range (5-30 km/h) and the walking band (< 5 km/h) where multi-fix
 * history is needed to disambiguate walking from drift.
 */
export function classifyMotion(speedKmh: number): MotionProfile {
	if (speedKmh > TRANSIT_FAST_KMH) return "transit-fast";
	if (speedKmh > TRANSIT_KMH) return "transit";
	if (speedKmh < 5) return "stationary";
	return null;
}

/** Drop fixes older than `nowSec - maxAgeSec`. Inclusive at the boundary. */
export function pruneFixHistory(history: FixRecord[], maxAgeSec: number, nowSec: number): FixRecord[] {
	const cutoff = nowSec - maxAgeSec;
	return history.filter((f) => f.ts >= cutoff);
}

function pathDistanceM(history: FixRecord[]): number {
	let d = 0;
	for (let i = 1; i < history.length; i++) {
		d += haversineMeters(history[i - 1].lat, history[i - 1].lon, history[i].lat, history[i].lon);
	}
	return d;
}

function netDisplacementM(history: FixRecord[]): number {
	if (history.length < 2) return 0;
	const first = history[0];
	const last = history[history.length - 1];
	return haversineMeters(first.lat, first.lon, last.lat, last.lon);
}

/** Effective speed across the whole history. Path distance / elapsed time. */
export function effectiveSpeedKmh(history: FixRecord[]): number {
	if (history.length < 2) return 0;
	const dt = history[history.length - 1].ts - history[0].ts;
	if (dt <= 0) return 0;
	return (pathDistanceM(history) / dt) * 3.6;
}

/** Net displacement / total path length, 0..1. */
export function straightnessRatio(history: FixRecord[]): number {
	if (history.length < 2) return 0;
	const path = pathDistanceM(history);
	if (path === 0) return 0;
	return netDisplacementM(history) / path;
}

function historySpansSec(history: FixRecord[]): number {
	if (history.length < 2) return 0;
	return history[history.length - 1].ts - history[0].ts;
}

/** Returns "walking" if history shows directional motion at walking pace,
 *  null otherwise. Caller prunes history to the desired window first. */
export function classifyFromHistory(history: FixRecord[]): MotionProfile {
	if (history.length < MIN_WALKING_FIXES) return null;
	const v = effectiveSpeedKmh(history);
	if (v < WALKING_MIN_KMH || v > WALKING_MAX_KMH) return null;
	if (straightnessRatio(history) < WALKING_MIN_STRAIGHTNESS) return null;
	return "walking";
}

// ============================================================================
// Signal extraction
// ============================================================================

/**
 * Reduce a fix history into the signals the decision pipeline consumes.
 * All numeric signals default to 0 when there's too little data to
 * compute them — predicates check `historySpanSec` to know whether a
 * given signal is meaningful.
 */
export function computeSignals(history: FixRecord[]): DecisionSignals {
	const empty: DecisionSignals = {
		reportedVelKmh: 0,
		computedVelKmh: 0,
		gapSinceLastFixSec: 0,
		effectiveSpeedKmh: 0,
		straightness: 0,
		historySpanSec: 0,
		trigger: null,
		monitoringMode: null,
	};
	if (history.length === 0) return empty;
	const last = history[history.length - 1];
	const reportedVelKmh = last.vel ?? 0;
	const trigger = last.trigger ?? null;
	const monitoringMode = last.monitoringMode ?? null;
	if (history.length === 1) {
		return { ...empty, reportedVelKmh, trigger, monitoringMode };
	}
	const prev = history[history.length - 2];
	const gap = last.ts - prev.ts;
	const distM = haversineMeters(prev.lat, prev.lon, last.lat, last.lon);
	const computedVelKmh = gap > 0 ? (distM / gap) * 3.6 : 0;
	return {
		reportedVelKmh,
		computedVelKmh,
		gapSinceLastFixSec: gap,
		effectiveSpeedKmh: effectiveSpeedKmh(history),
		straightness: straightnessRatio(history),
		historySpanSec: historySpansSec(history),
		trigger,
		monitoringMode,
	};
}

// ============================================================================
// Decision predicates
// ============================================================================

/** Is the phone reasonably understood to be in Significant ("energy
 *  saving") mode? Prefers the `m` field from the latest fix as ground
 *  truth — that's what the phone is actually doing right now. Falls back
 *  to "last profile we pushed" only when the phone hasn't told us. */
function isPhoneInSignificant(monitoringMode: number | null, prevProfile: MotionProfile): boolean {
	if (monitoringMode === 1) return true;
	if (monitoringMode === 2) return false;
	return prevProfile === "stationary" || prevProfile === null;
}

/**
 * Predicate 1: single-fix or computed velocity above the transit threshold
 * is enough to instantly escalate. Robust to a missing `vel` field
 * because computed velocity from displacement is also considered. Returns
 * null if neither speed source clears the threshold.
 */
export function escalateOnHighSpeed(signals: DecisionSignals): MotionProfile {
	const speed = Math.max(signals.reportedVelKmh, signals.computedVelKmh);
	if (speed > TRANSIT_FAST_KMH) return "transit-fast";
	if (speed > TRANSIT_KMH) return "transit";
	return null;
}

/**
 * Predicate 2: when the phone is in Significant mode, look for evidence
 * that it should be in Move. Three sources of evidence (any one is
 * enough): an Owntracks user-action trigger, a fix arriving much sooner
 * than the scheduled Significant cadence (the phone's motion sensor
 * fired), or visible displacement above walking pace. If history is rich
 * enough to refine, picks the precise profile; otherwise pushes a
 * conservative transit profile to get Move mode going.
 *
 * Self-gates on `signals.monitoringMode`: returns null when the phone
 * explicitly reports `m=2` (already in Move) so direct callers can't
 * accidentally over-fire. The cascade in `decideTransition` runs this
 * predicate only inside the Significant branch, but the predicate is
 * exported and a misleading contract here would invite regressions.
 */
export function escalateFromSignificant(signals: DecisionSignals): MotionProfile {
	if (signals.monitoringMode === 2) return null;
	const speed = Math.max(signals.reportedVelKmh, signals.computedVelKmh);
	const motionEvidence =
		signals.trigger === "u" ||
		(signals.gapSinceLastFixSec > 0 && signals.gapSinceLastFixSec < SIGNIFICANT_MODE_MOTION_GAP_SEC) ||
		speed > WALKING_MIN_KMH;
	if (!motionEvidence) return null;

	if (signals.historySpanSec >= MIN_HISTORY_SPAN_FOR_REFINE_SEC) {
		if (signals.effectiveSpeedKmh > TRANSIT_FAST_KMH) return "transit-fast";
		if (signals.effectiveSpeedKmh > TRANSIT_KMH) return "transit";
		if (
			signals.effectiveSpeedKmh >= WALKING_MIN_KMH &&
			signals.effectiveSpeedKmh <= WALKING_MAX_KMH &&
			signals.straightness >= WALKING_MIN_STRAIGHTNESS
		) {
			return "walking";
		}
	}
	return "transit";
}

/**
 * Predicate 3: when the phone is in Move mode and we have enough history,
 * pick the precise profile from effective speed + straightness. Returns
 * null if history is too thin or no profile applies (mid-range
 * effective speed without a walking signature).
 */
export function refineInMove(signals: DecisionSignals): MotionProfile {
	if (signals.historySpanSec < MIN_HISTORY_SPAN_FOR_REFINE_SEC) return null;
	if (signals.effectiveSpeedKmh > TRANSIT_FAST_KMH) return "transit-fast";
	if (signals.effectiveSpeedKmh > TRANSIT_KMH) return "transit";
	if (
		signals.effectiveSpeedKmh >= WALKING_MIN_KMH &&
		signals.effectiveSpeedKmh <= WALKING_MAX_KMH &&
		signals.straightness >= WALKING_MIN_STRAIGHTNESS
	) {
		return "walking";
	}
	return null;
}

/** Context the long-stay gate needs to decide whether demotion is
 *  appropriate at the current location. See `isLongStayLocation` in
 *  `owntracks-long-stay.ts` for how the boolean is derived. */
export interface LocationContext {
	/** True when the current fix lies inside a focus_place where the
	 *  user historically stays for hours. Demotion to Significant is
	 *  gated on this so a 30-minute supermarket browse doesn't lose
	 *  Move-mode tracking right before the user walks out. */
	atLongStayLocation: boolean;
}

const DEFAULT_LOCATION_CONTEXT: LocationContext = { atLongStayLocation: false };

/**
 * Predicate 4: demote to Significant only when (a) we have 10+ minutes
 * of sustained low-speed history AND (b) we're at a location where the
 * user historically lingers. Without (b), a 30-min Lidl visit would
 * flip the phone to Significant just as the user is about to walk out.
 *
 * Without an explicit location context (legacy callers, tests that
 * don't care about geography), default is `atLongStayLocation: false`
 * — never demote. That's the safe direction: worst case is slightly
 * more battery used than necessary.
 */
export function demoteAfterStop(
	signals: DecisionSignals,
	location: LocationContext = DEFAULT_LOCATION_CONTEXT,
	manualHoldActive = false,
): MotionProfile {
	// Manual-override hold: the user explicitly asked for high-frequency
	// tracking (a userAction push). Honour it by never demoting while the
	// hold is active — stay in Move and let fresh observation decide once
	// it expires, instead of reverting to the stale "been here for hours"
	// history. See MANUAL_OVERRIDE_HOLD_SEC.
	if (manualHoldActive) return null;
	if (!location.atLongStayLocation) return null;
	if (signals.historySpanSec < MIN_STATIONARY_DEMOTE_SEC) return null;
	if (signals.effectiveSpeedKmh >= WALKING_MIN_KMH) return null;
	return "stationary";
}

// ============================================================================
// Top-level decision
// ============================================================================

/** "keep" means "no transition this fix" — caller preserves lastProfile. */
export type Transition = MotionProfile | "keep";

/**
 * Run the signals through the predicate cascade. Priority order:
 *
 *   1. High-speed escalation (single fix or computed) — wins everywhere
 *      because boarding a train shouldn't wait for history.
 *   2. Significant→Move escalation — only fires when the phone is
 *      currently in Significant (no point escalating from Move).
 *   3. Move-mode refinement — picks the precise profile based on
 *      history.
 *   4. Move→Significant demotion — only after sustained evidence of
 *      stopping.
 *
 * "keep" propagates back to the caller as "no patch, preserve last
 * profile."
 */
export function decideTransition(
	signals: DecisionSignals,
	prevProfile: MotionProfile,
	location: LocationContext = DEFAULT_LOCATION_CONTEXT,
	manualHoldActive = false,
): Transition {
	const fast = escalateOnHighSpeed(signals);
	if (fast !== null) return fast;

	if (isPhoneInSignificant(signals.monitoringMode, prevProfile)) {
		return escalateFromSignificant(signals) ?? "keep";
	}

	return refineInMove(signals) ?? demoteAfterStop(signals, location, manualHoldActive) ?? "keep";
}

// ============================================================================
// Profile → patch mapping
// ============================================================================

/** Owntracks settings per motion regime. */
const PROFILE_CONFIG: Record<Exclude<MotionProfile, null>, OwntracksConfigPatch> = {
	"transit-fast": { monitoring: 2, moveModeLocatorInterval: 10 },
	transit: { monitoring: 2, moveModeLocatorInterval: 15 },
	walking: { monitoring: 2, moveModeLocatorInterval: 30 },
	stationary: { monitoring: 1 },
};

// ============================================================================
// Public wrapper with anti-flap
// ============================================================================

export interface RemoteConfigOptions {
	/** Whether the current fix lies inside a focus_place the user
	 *  historically stays at for hours. Gates Move→Significant
	 *  demotion. Default false (no demote) when omitted. */
	atLongStayLocation?: boolean;
	/** Whether a manual-override hold is active (the user recently asked
	 *  for high-frequency tracking via a userAction push). Suppresses
	 *  Move→Significant demotion so the override isn't clobbered. Default
	 *  false. */
	manualHoldActive?: boolean;
}

/** Profile used when we have never decided anything for this device.
 *  Matches the phone's factory-default monitoring mode (Significant)
 *  so the first-ever fix's pushed config is a no-op on the phone. */
const DEFAULT_PROFILE: Exclude<MotionProfile, null> = "stationary";

/**
 * Top-level decision. Always returns a concrete profile + patch — the
 * proxy pushes the full config on every fix and lets the phone treat
 * it as idempotent. There's no anti-flap, no per-device push-timestamp
 * memory, no "did this change from last time" dedup. If the predicate
 * cascade says "keep", we resolve to the last decided profile (or to
 * `DEFAULT_PROFILE` on the very first fix) and push its config anyway.
 *
 * `speedKmh` is the single-fix velocity convenience argument used when
 * the caller has no history yet; with history, `computeSignals` derives
 * the same value (and more) from the last fix.
 */
export function decideRemoteConfig(
	speedKmh: number,
	lastProfile: MotionProfile,
	history: FixRecord[] = [],
	options: RemoteConfigOptions = {},
): { profile: Exclude<MotionProfile, null>; patch: OwntracksConfigPatch } {
	const signals: DecisionSignals =
		history.length > 0
			? computeSignals(history)
			: {
					reportedVelKmh: speedKmh,
					computedVelKmh: 0,
					gapSinceLastFixSec: 0,
					effectiveSpeedKmh: 0,
					straightness: 0,
					historySpanSec: 0,
					trigger: null,
					monitoringMode: null,
				};

	const location: LocationContext = { atLongStayLocation: options.atLongStayLocation ?? false };
	const next = decideTransition(signals, lastProfile, location, options.manualHoldActive ?? false);
	const resolved: Exclude<MotionProfile, null> =
		next === "keep" || next === null ? (lastProfile ?? DEFAULT_PROFILE) : next;

	return { profile: resolved, patch: PROFILE_CONFIG[resolved] };
}

// ============================================================================
// Route handler state
// ============================================================================

/** Maximum number of distinct (token,device) state keys we'll retain at
 *  once. Single-user setups only ever populate 1-3 keys, but a cap
 *  prevents unbounded growth if a misconfigured client cycles device
 *  names or tokens. Eviction is LRU-by-recency-of-write — a key gets
 *  re-promoted every time we touch it. */
const MAX_STATE_KEYS = 32;

/** Promote `key` to most-recently-used in every state map. JS Maps
 *  preserve insertion order, so we delete + re-insert each existing
 *  value to move it to the end. The caller will replace `historyByKey`
 *  with the freshly merged history; `lastProfileByKey` is restored in
 *  place so the proxy doesn't forget its last decided profile between
 *  requests. */
function touchStateKey(key: string): void {
	const existingProfile = lastProfileByKey.get(key);
	historyByKey.delete(key);
	lastProfileByKey.delete(key);

	while (historyByKey.size >= MAX_STATE_KEYS) {
		const oldest = historyByKey.keys().next().value;
		if (oldest === undefined) break;
		historyByKey.delete(oldest);
		lastProfileByKey.delete(oldest);
		manualHoldUntilByKey.delete(oldest);
		// If this device comes back later, treat it as a cold start
		// and seed again — the long absence likely means the cache
		// is no longer representative.
		seedAttempted.delete(oldest);
	}

	if (existingProfile !== undefined) lastProfileByKey.set(key, existingProfile);
}

/** Per (token,device) memory of the last decided motion profile. */
const lastProfileByKey = new Map<string, MotionProfile>();
/** Per-device fix history used by the decision pipeline. */
const historyByKey = new Map<string, FixRecord[]>();
/** Per (token,device) flag: have we already attempted to seed this
 *  key's history from PhoneTrack since the process started? Seeding
 *  is a one-shot per pod lifetime per device — repeat attempts would
 *  hammer Nextcloud on every POST if NC is unreachable. */
const seedAttempted = new Set<string>();
/** Per (token,device) unix-second deadline until which a manual-override
 *  hold is active. Set when the phone sends a userAction (`t=u`) push;
 *  while `now < deadline`, auto-demotion to Significant is suppressed so
 *  the user's "high frequency now" request isn't clobbered. In-memory,
 *  best-effort — a pod restart simply forgets an active hold. */
const manualHoldUntilByKey = new Map<string, number>();

/**
 * On the first fix after pod start for a given (token,device),
 * fetch the last `HISTORY_MAX_AGE_SEC` of PhoneTrack points and use
 * them to seed the in-memory history cache. Without this, every
 * pod restart resets the decision pipeline to `hist=1` and the
 * proxy makes premature Move-mode escalations on what would
 * otherwise be a stationary device at home.
 *
 * The in-memory cache is load-bearing: it affects every decision
 * the pipeline makes, and PhoneTrack is the source of truth for
 * the same fixes anyway. Seeding closes the gap.
 *
 * Failure modes (Nextcloud unreachable, user not linked, reauth
 * required) are non-fatal — we return an empty seed and the
 * pipeline runs with whatever fixes Owntracks sends next.
 */
async function seedHistoryFromPhoneTrack(
	config: { nextcloud: { baseUrl: string } },
	userId: string,
	nowSec: number,
): Promise<FixRecord[]> {
	const startSec = nowSec - HISTORY_MAX_AGE_SEC;
	const startIso = new Date(startSec * 1000).toISOString();
	const endIso = new Date(nowSec * 1000).toISOString();
	try {
		const points = await fetchTrackPoints(config, userId, startIso, endIso);
		// PhoneTrack's speed field is in m/s; convert to km/h to match
		// the Owntracks `vel` convention used by the rest of the
		// pipeline. Null stays null. Trigger and monitoringMode are
		// unknown for historical fixes; null is the right answer (the
		// pipeline only consults the *latest* fix's `t` and `m`, which
		// will always be from a live Owntracks payload).
		return points.map((p) => ({
			ts: p.ts,
			lat: p.lat,
			lon: p.lon,
			vel: p.speed === null ? null : p.speed * 3.6,
			trigger: null,
			monitoringMode: null,
		}));
	} catch (e) {
		if (e instanceof NextcloudNotLinkedError || e instanceof NextcloudReauthRequiredError) {
			return [];
		}
		console.warn(`Owntracks seed failed for device=${userId}: ${(e as Error).message ?? e}`);
		return [];
	}
}

// ============================================================================
// Route
// ============================================================================

export function owntracksRoutes(config: Config): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const allowedTokens = new Set(config.owntracks.allowedTokens);

	app.post(
		"/:token/:device",
		bodyLimit({
			maxSize: MAX_BODY_BYTES,
			onError: (c) => c.json({ error: "payload too large" }, 413),
		}),
		async (c) => {
			const token = c.req.param("token");
			const device = c.req.param("device");

			// Auth gate: require HTTP Basic Auth header presence (Owntracks
			// Android always sends it) and validate the URL token against the
			// configured allowlist. Both guard the in-process state maps and
			// avoid pointless upstream round-trips on adversarial probes.
			if (!c.req.header("Authorization")) {
				return c.json({ error: "authorization required" }, 401);
			}
			if (!allowedTokens.has(token)) {
				return c.json({ error: "token not permitted" }, 403);
			}

			const rawBody = await c.req.text();
			let payload: OwntracksLocation | OwntracksLocation[];
			try {
				payload = JSON.parse(rawBody);
			} catch {
				return c.json({ error: "invalid json" }, 400);
			}

			// Forward verbatim to Nextcloud PhoneTrack. Owntracks sends HTTP
			// Basic Auth (username/password configured in the app); PhoneTrack
			// relies on that for write authorisation, so we pass it through
			// along with the body. User-Agent is forwarded so PhoneTrack-side
			// logs/rate-limiting attribute correctly to the real client.
			const phonetrackUrl = `${config.nextcloud.baseUrl}/apps/phonetrack/log/owntracks/${token}/${device}`;
			const forwardedHeaders: Record<string, string> = {
				"Content-Type": c.req.header("Content-Type") ?? "application/json",
			};
			const auth = c.req.header("Authorization");
			if (auth) forwardedHeaders.Authorization = auth;
			const ua = c.req.header("User-Agent");
			if (ua) forwardedHeaders["User-Agent"] = ua;
			const upstreamRes = await fetch(phonetrackUrl, {
				method: "POST",
				headers: forwardedHeaders,
				body: rawBody,
			}).catch((err: unknown) => {
				console.warn(`Owntracks proxy: PhoneTrack POST failed for token ${token}: ${err}`);
				return null;
			});

			if (upstreamRes === null) return c.json({ error: "upstream unreachable" }, 502);
			if (!upstreamRes.ok) return c.json({ error: "upstream rejected" }, upstreamRes.status as 400 | 502);

			// Build fix records from the payload. We retain only `location`
			// messages with full position; pings without coordinates contribute
			// to nothing useful for our decision.
			const messages = Array.isArray(payload) ? payload : [payload];
			const stateKey = `${token}/${device}`;
			const newFixes: FixRecord[] = [];
			// Per-fix motion witness (heading/vel/acc) to persist for PDR (#296) —
			// `device` is the user_id by Owntracks-config convention.
			const motionRows: Array<{
				user_id: string;
				ts: number;
				lat: number;
				lon: number;
				cog: number | null;
				vel: number | null;
				acc: number | null;
			}> = [];
			for (const msg of messages) {
				if (msg.lat !== undefined && msg.lon !== undefined && msg.tst !== undefined) {
					newFixes.push({
						ts: msg.tst,
						lat: msg.lat,
						lon: msg.lon,
						vel: msg.vel ?? null,
						trigger: msg.t ?? null,
						monitoringMode: msg.m ?? null,
					});
					motionRows.push({
						user_id: device,
						ts: msg.tst,
						lat: msg.lat,
						lon: msg.lon,
						cog: typeof msg.cog === "number" && msg.cog >= 0 ? Math.round(msg.cog) : null,
						vel: typeof msg.vel === "number" ? Math.round(msg.vel) : null,
						acc: typeof msg.acc === "number" ? Math.round(msg.acc) : null,
					});
				}
			}
			// Persist the motion witness — best-effort so nothing here (a DB hiccup,
			// or no pool at all in a unit test) can break the fix forward or the
			// load-bearing mode decision. The try/catch guards a synchronous throw
			// from `db()`; the `.catch` guards async rejection. Duplicate
			// (user_id, ts) rows are ignored (Owntracks can re-POST a fix).
			if (motionRows.length > 0) {
				try {
					void db()
						.insertInto("motion_log")
						.values(motionRows)
						.ignore()
						.execute()
						.catch((e: unknown) => console.warn(`motion_log persist failed: ${(e as Error).message}`));
				} catch (e) {
					console.warn(`motion_log persist skipped: ${(e as Error).message}`);
				}
			}
			const nowTs = newFixes.length > 0 ? newFixes[newFixes.length - 1].ts : Math.floor(Date.now() / 1000);

			// Cold-start seed: if we've never seeded this key in this
			// pod lifetime and the cache has nothing, pull recent
			// fixes from PhoneTrack. This is the source of truth for
			// location storage anyway; the in-memory cache duplicates
			// it for low-latency decisions. Without this, every pod
			// restart resets `hist` to 1 and the cascade makes a
			// premature Move escalation on the next `t=u`.
			if (!seedAttempted.has(stateKey) && !historyByKey.has(stateKey)) {
				seedAttempted.add(stateKey);
				const seeded = await seedHistoryFromPhoneTrack(config, device, nowTs);
				if (seeded.length > 0) {
					historyByKey.set(stateKey, seeded);
					console.log(`owntracks seed: ${device} got ${seeded.length} fix(es) from PhoneTrack`);
				}
			}

			const merged = [...(historyByKey.get(stateKey) ?? []), ...newFixes];
			const history = pruneFixHistory(merged, HISTORY_MAX_AGE_SEC, nowTs);
			// LRU bookkeeping: promotes stateKey to most-recent and evicts the
			// oldest entries from every state map if we're above the cap.
			touchStateKey(stateKey);
			historyByKey.set(stateKey, history);

			const prevProfile = lastProfileByKey.get(stateKey) ?? null;

			const signals: DecisionSignals =
				history.length > 0
					? computeSignals(history)
					: {
							reportedVelKmh: 0,
							computedVelKmh: 0,
							gapSinceLastFixSec: 0,
							effectiveSpeedKmh: 0,
							straightness: 0,
							historySpanSec: 0,
							trigger: null,
							monitoringMode: null,
						};

			const maxVel = signals.reportedVelKmh;

			// Long-stay location gate: only demote to Significant at
			// places the user historically lingers (home, work). At a
			// supermarket or cafe we keep Move mode active so we don't
			// lose tracking right when the user walks out. The proxy's
			// "device" path-param is the user_id by Owntracks-config
			// convention; for multi-user setups this would need a
			// token→user mapping table.
			let atLongStayLocation = false;
			if (history.length > 0) {
				const latestFix = history[history.length - 1];
				const focusPlaces = await getFocusPlacesForGating(device);
				atLongStayLocation = isLongStayLocation(latestFix.lat, latestFix.lon, focusPlaces);
			}

			// Manual-override hold: a userAction push (t=u) is the user
			// explicitly asking for high-frequency tracking. Stamp a hold so
			// auto-demotion is suppressed for MANUAL_OVERRIDE_HOLD_SEC — the
			// proxy stays in Move and lets fresh observation decide, instead
			// of reverting to the stale "been home for hours" history.
			// (2026-06-07: home 3h → Significant → 14-min gap walking out.)
			if (signals.trigger === "u") {
				manualHoldUntilByKey.set(stateKey, nowTs + MANUAL_OVERRIDE_HOLD_SEC);
			}
			const manualHoldActive = (manualHoldUntilByKey.get(stateKey) ?? 0) > nowTs;

			const { profile, patch } = decideRemoteConfig(maxVel, prevProfile, history, {
				atLongStayLocation,
				manualHoldActive,
			});

			// One-line decision log per Owntracks POST — makes proxy behaviour
			// debuggable from `kubectl logs` without instrumenting the phone.
			// Fields: vel = reported velocity, cvel = computed velocity from
			// displacement, hist = fix count, eff = history-effective speed,
			// str = straightness, gap = seconds since previous fix, t = Owntracks
			// trigger type, m = monitoring mode reported by phone, prev->next =
			// profile transition, patch = the config command (always sent).
			console.log(
				`owntracks ${token.slice(0, 6)}/${device} vel=${signals.reportedVelKmh.toFixed(1)} cvel=${signals.computedVelKmh.toFixed(1)} hist=${history.length} eff=${signals.effectiveSpeedKmh.toFixed(1)}km/h str=${signals.straightness.toFixed(2)} gap=${signals.gapSinceLastFixSec}s t=${signals.trigger ?? "-"} m=${signals.monitoringMode ?? "-"} longStay=${atLongStayLocation ? "y" : "n"} hold=${manualHoldActive ? "y" : "n"} ${prevProfile ?? "init"}->${profile} ${JSON.stringify(patch)}`,
			);

			lastProfileByKey.set(stateKey, profile);

			// Preserve PhoneTrack's response body (the "you are your own
			// friend" location-echo Owntracks needs to render the user's marker
			// on its in-app map). Append our cmd to that array.
			let baseResponse: unknown[] = [];
			try {
				const upstreamBody = await upstreamRes.text();
				if (upstreamBody.trim().length > 0) {
					const parsed = JSON.parse(upstreamBody);
					if (Array.isArray(parsed)) baseResponse = parsed;
				}
			} catch {
				// Upstream returned non-JSON; nothing to pass through.
			}

			baseResponse.push({
				_type: "cmd",
				action: "setConfiguration",
				configuration: { _type: "configuration", ...patch },
			} satisfies OwntracksCommand);
			return c.json(baseResponse);
		},
	);

	return app;
}
