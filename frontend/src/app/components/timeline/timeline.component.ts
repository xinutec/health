import { Component, computed, input, signal, ChangeDetectionStrategy } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import type { DayState, TrackSegment, VelocityData } from "../../services/health.service";

interface TimelineEntry {
  startLabel: string;
  /** Day-offset annotation (e.g. "−1d", "+1d") when the state's
   *  start falls on a different calendar day than referenceDate;
   *  empty otherwise. Rendered on its own line below startLabel so
   *  the time column doesn't have to widen for overlong labels. */
  startDayOffset: string;
  endLabel: string;
  durationLabel: string;
  /** Raw span in seconds — summed across legs to total a journey. */
  durationSeconds: number;
  mode: string;
  icon: string;
  primary: string;
  secondary?: string;
  /** Road / transit-line / station-pair text (moving states only).
   *  Kept alongside the assembled `secondary` so a journey summary can
   *  surface transit-line names without re-parsing display strings. */
  wayName?: string;
  /** State was asserted from surrounding days, not observed. */
  inferred: boolean;
}

/** A consecutive run of ≥2 moving legs between two visits, collapsed
 *  into one row by default. The individual legs are preserved and
 *  revealed on expand — the grouping is display-only, never touching
 *  the underlying state timeline. */
interface TimelineJourney {
  /** Stable id (position among journeys) driving per-row expand state. */
  index: number;
  startLabel: string;
  startDayOffset: string;
  endLabel: string;
  /** One mode icon per leg, in travel order. */
  icons: string[];
  /** Collapsed one-liner: "→ {destination} · {total}", falling back to
   *  transit-line names or bare duration when no destination is known. */
  summaryLabel: string;
  /** Any leg carried inferred (no-data) status. */
  inferred: boolean;
  legs: TimelineEntry[];
}

type TimelineRow =
  | { kind: "city"; city: string }
  | { kind: "entry"; entry: TimelineEntry }
  | { kind: "journey"; journey: TimelineJourney };

const MODE_ICONS: Record<string, string> = {
  sleeping: "bedtime",
  stationary: "place",
  walking: "directions_walk",
  cycling: "directions_bike",
  driving: "directions_car",
  bus: "directions_bus",
  train: "train",
  plane: "flight",
  boat: "directions_boat",
  unknown: "signal_disconnected",
};

/** Modes that count as transit legs eligible to fold into a journey.
 *  Deliberately excludes `stationary`/`sleeping` (visits — the signal,
 *  always their own row) and `unknown` (a GPS gap, not a leg — it
 *  breaks a run rather than joining it). */
const MOVING_MODES = new Set(["walking", "cycling", "driving", "bus", "train", "plane", "boat"]);

@Component({
  selector: "app-timeline",
  standalone: true,
  imports: [NgTemplateOutlet, MatCardModule, MatIconModule],
  templateUrl: "./timeline.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./timeline.component.scss",
})
export class TimelineComponent {
  readonly data = input<VelocityData | null>(null);
  /** Calendar date being displayed (YYYY-MM-DD). Used to compute
   *  -1d / +1d markers on state timestamps that fall outside the
   *  displayed day — typical for sleep windows that begin the
   *  previous evening or end the next morning. */
  readonly referenceDate = input<string | null>(null);

  readonly rows = computed<TimelineRow[]>(() => {
    const v = this.data();
    let flat: TimelineRow[];
    if (v?.states && v.states.length > 0) {
      flat = this.buildRowsFromStates(v.states, v.segments ?? []);
    } else if (!v?.segments?.length) {
      return [];
    } else {
      flat = this.buildRowsFromSegments(v.segments);
    }
    return this.coalesceJourneys(flat);
  });

  /** How many collapsible journeys the current day has — drives the
   *  expand-all / collapse-all control's visibility. */
  readonly journeyCount = computed(
    () => this.rows().filter((r) => r.kind === "journey").length,
  );

  /** Set of expanded journey indices. A day switch produces a fresh
   *  `rows()` with indices numbered from 0, so a stale set here only
   *  ever expands early journeys — harmless — but we reset it anyway
   *  through the data input's identity in practice. Signal + OnPush,
   *  matching the rest of the app; no MatExpansionModule. */
  private readonly expanded = signal<ReadonlySet<number>>(new Set());

  isExpanded(index: number): boolean {
    return this.expanded().has(index);
  }

  toggleJourney(index: number): void {
    const next = new Set(this.expanded());
    if (!next.delete(index)) next.add(index);
    this.expanded.set(next);
  }

  expandAll(): void {
    const all = new Set<number>();
    for (const r of this.rows()) if (r.kind === "journey") all.add(r.journey.index);
    this.expanded.set(all);
  }

  collapseAll(): void {
    this.expanded.set(new Set());
  }

  /** True when at least one journey is currently expanded — the
   *  toggle-all control flips to "Collapse all" in that case. */
  readonly anyExpanded = computed(() => this.expanded().size > 0);

  /** Fold each run of ≥2 consecutive moving entry-rows into one journey
   *  row, preserving the legs for on-demand expand. Visits, city
   *  headers, `unknown` gaps, and lone single-leg moves pass through
   *  untouched — a city change or a visit between two transit legs sits
   *  as a non-moving row and so naturally breaks a run. */
  private coalesceJourneys(rows: TimelineRow[]): TimelineRow[] {
    const out: TimelineRow[] = [];
    let journeyIdx = 0;
    let i = 0;
    while (i < rows.length) {
      const r = rows[i];
      if (r.kind === "entry" && MOVING_MODES.has(r.entry.mode)) {
        const legs: TimelineEntry[] = [];
        let j = i;
        while (j < rows.length) {
          const rj = rows[j];
          if (rj.kind !== "entry" || !MOVING_MODES.has(rj.entry.mode)) break;
          legs.push(rj.entry);
          j++;
        }
        if (legs.length >= 2) {
          out.push({ kind: "journey", journey: this.buildJourney(legs, journeyIdx++, rows, j) });
        } else {
          out.push(r); // lone leg — no benefit to hiding its way-name behind a click
        }
        i = j;
      } else {
        out.push(r);
        i++;
      }
    }
    return out;
  }

  /** Assemble the collapsed summary for a run of legs. `tailFrom` is the
   *  index just past the run, used to name the destination visit. */
  private buildJourney(
    legs: TimelineEntry[],
    index: number,
    rows: TimelineRow[],
    tailFrom: number,
  ): TimelineJourney {
    const first = legs[0];
    const last = legs[legs.length - 1];
    const totalSeconds = legs.reduce((sum, l) => sum + l.durationSeconds, 0);
    const durationLabel = this.formatDuration(totalSeconds);

    // Destination = the next visit after the run (skipping city headers).
    let destination: string | undefined;
    for (let k = tailFrom; k < rows.length; k++) {
      const rk = rows[k];
      if (rk.kind === "city") continue;
      if (rk.kind === "entry" && (rk.entry.mode === "stationary" || rk.entry.mode === "sleeping")) {
        destination = rk.entry.primary;
      }
      break;
    }

    // Transit-line names (train/bus legs) as a fallback subtitle when
    // there's no destination to point at (journey trailing off the day).
    const lineNames: string[] = [];
    for (const leg of legs) {
      if ((leg.mode === "train" || leg.mode === "bus") && leg.wayName && !lineNames.includes(leg.wayName)) {
        lineNames.push(leg.wayName);
      }
    }

    let summaryLabel: string;
    if (destination) {
      summaryLabel = `→ ${destination} · ${durationLabel}`;
    } else if (lineNames.length > 0) {
      summaryLabel = `${lineNames.join(" · ")} · ${durationLabel}`;
    } else {
      summaryLabel = durationLabel;
    }

    return {
      index,
      startLabel: first.startLabel,
      startDayOffset: first.startDayOffset,
      endLabel: last.endLabel,
      icons: legs.map((l) => l.icon),
      summaryLabel,
      inferred: legs.some((l) => l.inferred),
      legs,
    };
  }

  private buildRowsFromStates(states: DayState[], segments: TrackSegment[]): TimelineRow[] {
    const rows: TimelineRow[] = [];
    let lastCity: string | null = null;
    for (const state of states) {
      const city = this.cityForState(state, segments);
      if (city && city !== lastCity) {
        rows.push({ kind: "city", city });
        lastCity = city;
      }
      rows.push({ kind: "entry", entry: this.stateToEntry(state, segments) });
    }
    return rows;
  }

  private cityForState(state: DayState, segments: TrackSegment[]): string | undefined {
    const midTs = state.startTs + (state.endTs - state.startTs) / 2;
    const byMidpoint = segments.find((seg) => seg.startTs <= midTs && seg.endTs >= midTs && !!seg.city);
    if (byMidpoint?.city) return byMidpoint.city;
    // Synthesised sleeping states extend beyond segment coverage
    // (morning sleep before first fix; evening sleep after last
    // fix). Their midpoint falls in a no-segment gap, so look up
    // city by place match instead — any segment with the same
    // place lends its city tag. Without this fallback the city
    // header lands after the sleep row instead of above it.
    if (state.place) {
      const byPlace = segments.find((seg) => seg.place === state.place && !!seg.city);
      if (byPlace?.city) return byPlace.city;
    }
    return undefined;
  }

  private stateToEntry(state: DayState, segments: TrackSegment[]): TimelineEntry {
    const icon = MODE_ICONS[state.mode] ?? "place";
    const tz = state.tz ?? this.displayTzForState(state, segments);
    const startLabel = this.formatTime(state.startTs, tz);
    const startDayOffset = this.dayOffsetLabel(state.startTs, tz);
    const endLabel = this.formatTime(state.endTs, tz);
    const durationLabel = this.formatDuration(state.endTs - state.startTs);

    let primary: string;
    let secondary: string | undefined;

    if (state.mode === "sleeping") {
      primary = state.place ?? "Asleep";
      // Wall-clock span first, then the Fitbit "actually asleep" time
      // in parentheses. The two diverge by however long the user was
      // awake in bed — useful context that the bare duration hides.
      if (state.minutesAsleep !== undefined && state.minutesAsleep > 0) {
        const asleepLabel = this.formatDuration(state.minutesAsleep * 60);
        secondary = `${durationLabel} in bed (${asleepLabel} asleep)`;
      } else {
        secondary = `${durationLabel} sleeping`;
      }
    } else if (state.mode === "stationary") {
      primary = state.place ?? "Stopped";
      secondary = `${durationLabel} stationary`;
    } else if (state.mode === "unknown") {
      // No GPS coverage for this stretch — surface as a hedged, low-
      // confidence state rather than committing to a movement label.
      primary = "No GPS signal";
      secondary = `${durationLabel} · unknown`;
    } else {
      const verb = state.mode.charAt(0).toUpperCase() + state.mode.slice(1);
      primary = verb;
      const parts: string[] = [];
      if (state.wayName) parts.push(`on ${state.wayName}`);
      parts.push(durationLabel);
      if (state.asleep) parts.push("asleep");
      secondary = parts.join(" · ");
    }

    // Honest marker: this state had no data of its own — it's asserted
    // from the surrounding days (same place before and after). Confident,
    // but not observed.
    if (state.inferred) {
      secondary = secondary ? `${secondary} · no data (inferred)` : "no data (inferred)";
    }

    return {
      startLabel,
      startDayOffset,
      endLabel,
      durationLabel,
      durationSeconds: state.endTs - state.startTs,
      mode: state.mode,
      icon,
      primary,
      secondary,
      wayName: state.wayName,
      inferred: !!state.inferred,
    };
  }

  private displayTzForState(state: DayState, segments: TrackSegment[]): string | undefined {
    const midTs = state.startTs + (state.endTs - state.startTs) / 2;
    const s = segments.find((seg) => seg.startTs <= midTs && seg.endTs >= midTs && !!seg.displayTz);
    return s?.displayTz;
  }

  private buildRowsFromSegments(segments: TrackSegment[]): TimelineRow[] {
    const rows: TimelineRow[] = [];
    let lastCity: string | null = null;
    for (const s of segments) {
      if (s.city && s.city !== lastCity) {
        rows.push({ kind: "city", city: s.city });
        lastCity = s.city;
      }
      rows.push({ kind: "entry", entry: this.toEntry(s) });
    }
    return rows;
  }

  private toEntry(s: TrackSegment): TimelineEntry {
    const mode = s.refinedMode ?? s.mode;
    const icon = MODE_ICONS[mode] ?? "place";
    const tz = s.displayTz;
    const startLabel = this.formatTime(s.startTs, tz);
    const endLabel = this.formatTime(s.endTs, tz);
    const durationLabel = this.formatDuration(s.endTs - s.startTs);

    let primary: string;
    let secondary: string | undefined;

    if (mode === "stationary") {
      primary = s.place ?? "Stopped";
      secondary = `${durationLabel} stationary`;
    } else {
      const verb = mode.charAt(0).toUpperCase() + mode.slice(1);
      primary = `${verb} · ${s.avgSpeed} km/h`;
      if (s.wayName) {
        secondary = `On ${s.wayName} · ${durationLabel}`;
      } else if (s.refinedReason) {
        secondary = `${s.refinedReason} · ${durationLabel}`;
      } else {
        secondary = `${durationLabel} · max ${s.maxSpeed} km/h`;
      }
    }

    return {
      startLabel,
      startDayOffset: "",
      endLabel,
      durationLabel,
      durationSeconds: s.endTs - s.startTs,
      mode,
      icon,
      primary,
      secondary,
      wayName: s.wayName,
      inferred: false,
    };
  }

  /** "−1d", "+1d", "+2d" etc. when the instant falls on a different
   *  calendar day than `referenceDate`; empty string otherwise.
   *  Rendered on a separate line below the time so the column width
   *  stays narrow (a "23:43 (−1d)" suffix would otherwise overflow
   *  the right-aligned 56px time column to the left). */
  private dayOffsetLabel(unixTs: number, tz?: string): string {
    const ref = this.referenceDate();
    if (!ref) return "";
    const dateStr = this.formatDate(unixTs, tz);
    const offset = this.dayOffset(ref, dateStr);
    if (offset === 0) return "";
    const sign = offset > 0 ? "+" : "−";
    return `${sign}${Math.abs(offset)}d`;
  }

  private formatDate(unixTs: number, tz?: string): string {
    const d = new Date(unixTs * 1000);
    if (tz === undefined) {
      const y = d.getFullYear();
      const m = (d.getMonth() + 1).toString().padStart(2, "0");
      const day = d.getDate().toString().padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const y = parts.find((p) => p.type === "year")?.value ?? "0000";
    const m = parts.find((p) => p.type === "month")?.value ?? "00";
    const day = parts.find((p) => p.type === "day")?.value ?? "00";
    return `${y}-${m}-${day}`;
  }

  /** Integer day delta `actual - reference` (both YYYY-MM-DD).
   *  Returns 0 when same day, +1 when actual is the day after, etc. */
  private dayOffset(reference: string, actual: string): number {
    const ref = Date.UTC(
      Number(reference.slice(0, 4)),
      Number(reference.slice(5, 7)) - 1,
      Number(reference.slice(8, 10)),
    );
    const act = Date.UTC(
      Number(actual.slice(0, 4)),
      Number(actual.slice(5, 7)) - 1,
      Number(actual.slice(8, 10)),
    );
    return Math.round((act - ref) / 86400000);
  }

  private formatTime(unixTs: number, tz?: string): string {
    const d = new Date(unixTs * 1000);
    if (tz === undefined) {
      return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    }
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const h = parts.find((p) => p.type === "hour")?.value ?? "00";
    const m = parts.find((p) => p.type === "minute")?.value ?? "00";
    return `${h === "24" ? "00" : h}:${m}`;
  }

  private formatDuration(seconds: number): string {
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  }
}
