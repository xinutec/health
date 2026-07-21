import { Injectable, inject, signal } from "@angular/core";
import type { DayStateMode } from "../modes";
import { ConnectionStateService } from "./connection-state.service";

export interface ActivityDay {
  date: string;
  steps: number;
  calories_total: number;
  calories_active: number;
  distance_km: number;
  minutes_sedentary: number;
  minutes_lightly_active: number;
  minutes_fairly_active: number;
  minutes_very_active: number;
  resting_heart_rate: number | null;
}

export interface SleepLog {
  /** Fitbit's 64-bit sleep log id. Serialised as a string on the
   *  wire because JSON can't carry bigint natively (backend stores
   *  it as bigint and BigInt.prototype.toJSON stringifies it). */
  log_id: string;
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

export interface SleepStage {
  ts: string;
  stage: string;
  duration_seconds: number;
}

export interface HeartRatePoint {
  ts: string;
  bpm: number;
}

export interface VelocityPoint {
  ts: number;
  lat: number;
  lon: number;
  speed_kmh: number;
  bearing: number;
}

/** One phone-battery reading: charge level (integer percent, 0–100)
 *  at a wall-clock instant. Mirrors `BatterySample` in velocity.ts. */
export interface BatterySample {
  ts: number;
  level: number;
}

/** The mode a segment should be *shown* as.
 *
 *  Three fields encode it, and reading any one alone is wrong:
 *    - `mode` is the raw speed/shape classification, before any refinement.
 *    - `refinedMode` is what the OSM + rail + bus passes concluded, when they
 *      concluded anything.
 *    - `vehicleKind` turns a `driving` leg into a bus without changing `mode`.
 *
 *  The speed chart used to colour its bands off `seg.mode` alone, so the same
 *  screen showed a tube ride as "train" in the timeline and as a car in the
 *  chart. The backend has the identical helper (`src/geo/segment-util.ts`) with
 *  the identical warning; this is its client-side twin. */
export function effectiveMode(seg: TrackSegment): string {
  if (seg.vehicleKind === "bus") return "bus";
  return seg.refinedMode ?? seg.mode;
}

export interface TrackSegment {
  startTs: number;
  endTs: number;
  mode: string;
  /** 0-1 probability of the chosen mode, normalised across modes. */
  confidence: number;
  /** Ratio of best mode score to runner-up. > 2 unambiguous, ~1 ambiguous. */
  confidenceMargin: number;
  avgSpeed: number;
  maxSpeed: number;
  linearity: number;
  pointCount: number;
  // OSM enrichment (optional, may not be present if Nominatim/Overpass failed)
  place?: string;
  city?: string; // city/town/village (stationary segments) — used to group consecutive same-city entries
  wayName?: string;
  refinedMode?: string;
  /** Stop-pattern refinement of a road-vehicle leg: "bus" when the leg's
   *  dwells coincide with bus stops, or its endpoints match a bus route.
   *  The mode stays "driving"; this is what makes it a bus for display.
   *  Read it through `effectiveMode()` — never off `mode` directly. */
  vehicleKind?: "bus";
  refinedReason?: string;
  /** IANA tz the segment's timestamps should be rendered in.
   *  Derived per-segment from the segment's location (stationary
   *  centroid, moving midpoint). Lets the UI show times "as you
   *  experienced them" — morning in one tz, evening in another
   *  on a travel day. */
  displayTz?: string;
  // The segment-level path arrays (snappedPath/matchedPath/walkMatchedPath)
  // are pipeline intermediates; the API strips them — drawn geometry arrives
  // once, in `episodes`.
}

export interface DayState {
  startTs: number;
  endTs: number;
  mode: DayStateMode;
  /** Human-readable place (stationary / sleeping). */
  place?: string;
  /** Human-readable way (moving — road, line, station-pair). */
  wayName?: string;
  /** True iff user was asleep during a moving state (sleeping on a
   *  train, etc.). Omitted on mode=sleeping where it'd be redundant. */
  asleep?: boolean;
  /** IANA tz to render this state's timestamps in. Populated from
   *  the underlying segment, or from the sleep window's tz for
   *  synthesized sleeping intervals that have no overlapping
   *  segment. */
  tz?: string;
  /** For sleeping states only: minutes the user was actually asleep
   *  (Fitbit minutes_asleep). Differs from the wall-clock span by
   *  the time spent awake in bed. */
  minutesAsleep?: number;
  /** True when this state was inferred from the surrounding days rather
   *  than observed — no data for the day, but it's fully constrained
   *  (same place before and after). The timeline marks it "no data". */
  inferred?: boolean;
}

/** Display geometry for one episode, 1:1 with a DayState. The map
 *  renders these (not the raw segments) so it tells the same story as
 *  the narrative. `kind` is the only style input: solid for raw/matched,
 *  dashed for snapped/tentative, a dot for anchor. See
 *  src/geo/episode-geometry.ts. */
export interface EpisodeGeometry {
  startTs: number;
  endTs: number;
  mode: DayState["mode"];
  // Mirrors the backend EpisodeKind union (episode-geometry.ts) — hand-kept;
  // a kind missing here renders with default styling and a raw label.
  kind: "snapped" | "raw" | "anchor" | "tentative" | "matched" | "smoothed";
  points: { lat: number; lon: number; ts?: number }[];
  /** Stay label for an `anchor` episode — drives the marker popup. */
  place?: string;
}

/** IANA timezone to render a timestamp in: the covering segment's
 *  `displayTz` ("as you experienced it", same rule as the timeline),
 *  falling back to the nearest segment's, or undefined (browser tz)
 *  when the day has no tz-bearing segments. */
export function displayTzAt(segments: readonly TrackSegment[] | undefined, ts: number): string | undefined {
  if (!segments || segments.length === 0) return undefined;
  let nearest: TrackSegment | undefined;
  let nearestGap = Number.POSITIVE_INFINITY;
  for (const s of segments) {
    if (!s.displayTz) continue;
    if (ts >= s.startTs && ts <= s.endTs) return s.displayTz;
    const gap = ts < s.startTs ? s.startTs - ts : ts - s.endTs;
    if (gap < nearestGap) {
      nearestGap = gap;
      nearest = s;
    }
  }
  return nearest?.displayTz;
}

export interface VelocityData {
  points: VelocityPoint[];
  /** The raw, accuracy-bearing GPS fixes the map-matcher consumes — the input
   *  the drawn line is derived from. The map can overlay these so you can see
   *  the matched line against the actual GPS. Optional so an older backend that
   *  omits it doesn't break the client. */
  rawFixes?: { lat: number; lon: number; ts: number; accuracy?: number | null }[];
  segments: TrackSegment[];
  /** Non-overlapping state sequence — the "your day" narrative.
   *  Bottom layer of the three-altitude data model; sleep is folded
   *  in as a first-class mode. See src/sleep/day-state.ts. */
  states?: DayState[];
  /** Per-episode display geometry, 1:1 with `states`. Optional so an
   *  older backend that omits it doesn't break the client. */
  episodes?: EpisodeGeometry[];
  /** The day's phone-battery trace, compressed to run boundaries.
   *  Optional so an older backend that omits it doesn't break the
   *  client — the battery chart just shows "no data". */
  battery?: BatterySample[];
  /** The day's watch (Fitbit device) battery trace — one point per device
   *  sync, from `device_battery_log`. Plotted as a second series on the same
   *  chart. Optional + possibly empty (history builds going forward). */
  watchBattery?: BatterySample[];
  /** Per-phase wall-clock ms from the server-side classification pipeline. */
  timing?: Record<string, number>;
}

/** The most recent location fix — for the live "where are they now"
 *  marker on the Map tab. */
export interface LatestFix {
  lat: number;
  lon: number;
  ts: number;
  accuracy: number | null;
}

/** One raw PhoneTrack point in the live trajectory tail (past the classified
 *  track). Lighter than a full fix — just position + time. */
export interface TrackTailPoint {
  lat: number;
  lon: number;
  ts: number;
}

export interface UserInfo {
  userId: string;
  displayName: string;
  fitbitLinked: boolean;
  /** Per-connection status object. Old clients see only the
   *  top-level booleans; new clients use this richer view to render
   *  the reauth banner. */
  connections?: {
    nextcloud: { status: "active" | "needs_reauth" | "not_linked" };
    fitbit: { status: "active" | "not_linked" };
  };
  /** Present iff this request was authenticated via share token.
   *  The recipient SPA uses [from, to] to clamp day navigation. */
  shareWindow?: { from: string; to: string } | null;
}

export interface HrvDay {
  date: string;
  daily_rmssd: number;
  deep_rmssd: number;
}

export interface BodyDay {
  date: string;
  // DECIMAL columns come back as strings from the driver; the chart coerces.
  weight_kg: number | string | null;
  bmi: number | string | null;
  body_fat_pct: number | string | null;
}

export interface ShareStatus {
  active: boolean;
  token?: string;
  url?: string;
  daysBack?: number;
  createdAt?: string;
  lastAccessedAt?: string | null;
}

/** The verified-Lean-core master toggle state (GET/PUT /api/verified-core).
 *  `override` null = following the deploy-time env flags; true/false = the live
 *  override. `effective` is what the server is actually serving right now. */
export interface VerifiedCoreStatus {
  override: boolean | null;
  effective: { passes: string; matcher: string };
  defaults: { passes: string; matcher: string };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

@Injectable({ providedIn: "root" })
export class HealthService {
  readonly user = signal<UserInfo | null>(null);
  /** When the SPA was loaded at `/share/:token`, this holds the
   *  token. Every backend call attaches it as `X-Share-Token` so
   *  the recipient is authenticated as the owner (read-only,
   *  date-windowed — enforced server-side). Null in owner mode. */
  readonly shareToken = signal<string | null>(null);
  /** The owner's share-link status, or null until first loaded.
   *  Held on the service so the toolbar quick-copy button and the
   *  settings page read one source of truth — creating, rotating or
   *  revoking a share anywhere updates the toolbar immediately. */
  readonly shareStatus = signal<ShareStatus | null>(null);
  /** The verified-Lean-core toggle state, or null until first loaded. */
  readonly verifiedCore = signal<VerifiedCoreStatus | null>(null);
  private readonly connection = inject(ConnectionStateService);

  /** All HTTP calls go through here so the connection-state service
   *  can observe 409 reauth signals from any endpoint and flip the
   *  global banner. Mirrors `fetch`'s signature. Auto-attaches the
   *  share token header when present so share-mode SPAs work
   *  transparently. */
  private fetch(input: string, init?: RequestInit): Promise<Response> {
    const token = this.shareToken();
    if (!token) return this.connection.fetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set("X-Share-Token", token);
    return this.connection.fetch(input, { ...init, headers });
  }

  /** `Response.json()` is `any` — nothing on the wire is checked against `T`.
   *  This is the single place where the backend's shape is taken on trust, so
   *  the assertion is stated here once instead of implied at every call. */
  private static async body<T>(res: Response): Promise<T> {
    return (await res.json()) as T;
  }

  async checkAuth(): Promise<boolean> {
    try {
      const res = await this.fetch("/api/me");
      if (res.ok) {
        const info = (await res.json()) as UserInfo;
        this.user.set(info);
        // Seed connection-state from /api/me so the banner can render
        // on app-load without waiting for the first 409 from a data
        // endpoint. Falls back to legacy boolean when the new field
        // isn't present (server older than this client).
        if (info.connections?.nextcloud) {
          this.connection.setNextcloudStatus(info.connections.nextcloud.status);
        } else {
          this.connection.setNextcloudStatus("active"); // optimistic on legacy backends
        }
        return true;
      }
    } catch {
      // not authenticated
    }
    this.user.set(null);
    return false;
  }

  // The optional `signal` on each per-day/window fetch lets a caller —
  // notably an Angular `resource()` — abort an in-flight request when
  // its inputs change. The signal flows straight into `fetch`, so a
  // superseded day-navigation cancels on the wire instead of racing to
  // completion and being discarded.
  async getHrv(days = 30, signal?: AbortSignal): Promise<HrvDay[]> {
    const res = await this.fetch(`/api/hrv?days=${days}`, { signal });
    if (!res.ok) throw new Error("Failed to fetch HRV");
    return HealthService.body<HrvDay[]>(res);
  }

  async getBody(days = 30, signal?: AbortSignal): Promise<BodyDay[]> {
    const res = await this.fetch(`/api/body?days=${days}`, { signal });
    if (!res.ok) throw new Error("Failed to fetch body");
    return HealthService.body<BodyDay[]>(res);
  }

  async getActivity(days = 30, signal?: AbortSignal): Promise<ActivityDay[]> {
    const res = await this.fetch(`/api/activity?days=${days}`, { signal });
    if (!res.ok) throw new Error("Failed to fetch activity");
    return HealthService.body<ActivityDay[]>(res);
  }

  async getSleep(days = 30, signal?: AbortSignal): Promise<SleepLog[]> {
    const res = await this.fetch(`/api/sleep?days=${days}`, { signal });
    if (!res.ok) throw new Error("Failed to fetch sleep");
    return HealthService.body<SleepLog[]>(res);
  }

  async getSleepStages(date = today(), signal?: AbortSignal): Promise<SleepStage[]> {
    const res = await this.fetch(`/api/sleep/stages?date=${date}`, { signal });
    if (!res.ok) throw new Error("Failed to fetch sleep stages");
    return HealthService.body<SleepStage[]>(res);
  }

  async getHeartRateIntraday(date = yesterday(), signal?: AbortSignal): Promise<HeartRatePoint[]> {
    const res = await this.fetch(`/api/heartrate/intraday?date=${date}`, { signal });
    if (!res.ok) throw new Error("Failed to fetch heart rate intraday");
    return HealthService.body<HeartRatePoint[]>(res);
  }

  async getVelocity(date = yesterday(), signal?: AbortSignal, walkMatch = true): Promise<VelocityData> {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // walkMatch=0 asks the server to skip pedestrian map-matching, so the map can
    // render the raw walks for an A/B comparison.
    const wm = walkMatch ? "" : "&walkMatch=0";
    const res = await this.fetch(`/api/velocity?date=${date}&tz=${encodeURIComponent(tz)}${wm}`, { signal });
    if (!res.ok) throw new Error("Failed to fetch velocity data");
    return HealthService.body<VelocityData>(res);
  }

  /** The most recent location fix, for the live map marker. Returns
   *  null when there is no fix to show (no PhoneTrack data, or — for a
   *  share viewer — today is outside the share window). Never throws:
   *  a failed poll just leaves the marker where it was. */
  async getLatestFix(): Promise<LatestFix | null> {
    try {
      const res = await this.fetch(`/api/location/latest`);
      if (!res.ok) return null;
      return (await res.json()) as LatestFix | null;
    } catch {
      return null;
    }
  }

  /** Raw PhoneTrack fixes recorded AFTER `since` (epoch seconds) — the live
   *  trajectory tail the Map tab draws past the end of the classified track.
   *  Never throws; a failed poll just leaves the tail as-is. */
  async getLocationTail(since: number): Promise<TrackTailPoint[]> {
    try {
      const res = await this.fetch(`/api/location/tail?since=${since}`);
      if (!res.ok) return [];
      const body = (await res.json()) as unknown;
      return Array.isArray(body) ? (body as TrackTailPoint[]) : [];
    } catch {
      return [];
    }
  }

  /** Fire-and-forget — sets PhoneTrack's visualisation date filter to a
   * sensible default (yesterday 00:00 if before 06:00 local, else today
   * 00:00, no end). Called on dashboard load so navigating to PhoneTrack
   * always shows the relevant range. */
  async syncPhoneTrackFilter(): Promise<void> {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      await this.fetch(`/api/phonetrack/sync-filter?tz=${encodeURIComponent(tz)}`, { method: "POST" });
    } catch {
      // Non-fatal — the dashboard works regardless.
    }
  }

  // ─── Share-token management (owner only) ────────────────────
  async getShareStatus(): Promise<ShareStatus> {
    const res = await this.fetch("/api/share");
    if (!res.ok) throw new Error(`share status failed: ${res.status}`);
    return HealthService.body<ShareStatus>(res);
  }

  /** Fetch the share status and publish it on the `shareStatus`
   *  signal. Throws on failure — the settings page surfaces the
   *  error; the toolbar loader ignores it (a missing quick-copy
   *  button is harmless). */
  async refreshShareStatus(): Promise<void> {
    this.shareStatus.set(await this.getShareStatus());
  }

  async createOrRotateShare(daysBack: number): Promise<ShareStatus> {
    const res = await this.fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daysBack }),
    });
    if (!res.ok) throw new Error(`share create failed: ${res.status}`);
    const status = (await res.json()) as ShareStatus;
    this.shareStatus.set(status);
    return status;
  }

  /** Change how many days the existing share exposes, WITHOUT rotating
   *  the token — the recipient's link keeps working. */
  async updateShareDays(daysBack: number): Promise<ShareStatus> {
    const res = await this.fetch("/api/share", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daysBack }),
    });
    if (!res.ok) throw new Error(`share update failed: ${res.status}`);
    const status = (await res.json()) as ShareStatus;
    this.shareStatus.set(status);
    return status;
  }

  async revokeShare(): Promise<void> {
    const res = await this.fetch("/api/share", { method: "DELETE" });
    if (!res.ok && res.status !== 204) throw new Error(`share revoke failed: ${res.status}`);
    this.shareStatus.set({ active: false });
  }

  // ─── Verified-Lean-core master toggle (owner only) ────────────
  async refreshVerifiedCore(): Promise<void> {
    const res = await this.fetch("/api/verified-core");
    if (!res.ok) throw new Error(`verified-core status failed: ${res.status}`);
    this.verifiedCore.set(await HealthService.body<VerifiedCoreStatus>(res));
  }

  /** Set (true/false) or clear (null → follow the deploy default) the master
   *  override. Publishes the returned effective state on the signal. */
  async setVerifiedCore(enabled: boolean | null): Promise<void> {
    const res = await this.fetch("/api/verified-core", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`verified-core update failed: ${res.status}`);
    this.verifiedCore.set(await HealthService.body<VerifiedCoreStatus>(res));
  }

  /** Diagnostic logging: post `event` + arbitrary `data` to the
   *  backend, which writes it to pod stdout. Lets us observe
   *  client-side behaviour from `kubectl logs` for issues that
   *  can't be reproduced without the user's device. Best-effort;
   *  network failures are swallowed so this never breaks the UI. */
  async clientLog(event: string, data?: Record<string, unknown>): Promise<void> {
    try {
      await this.fetch("/api/client-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, data }),
      });
    } catch {
      // Best-effort — never let logging break the dashboard.
    }
  }
}
