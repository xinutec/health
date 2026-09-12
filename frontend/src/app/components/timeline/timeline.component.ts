import { Component, computed, input, signal, ChangeDetectionStrategy } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { modeStyle } from "../../modes";
import { todayLocal } from "../../time-utils";
import type { DayState, ServedJourney, TrackSegment, VelocityData } from "../../services/health.service";

interface TimelineEntry {
  /** The state's own start instant — what a served journey's span is matched
   *  against, since the labels are already localised and cannot be compared. */
  startTs: number;
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
  /** Collapsed one-liner: the transports (non-walking legs) by mode, in
   *  order — "Train · Bus · {total}" — since the destination just repeats
   *  the visit row below and the line detail lives in the expanded legs.
   *  Bare duration for an all-walking journey. */
  summaryLabel: string;
  /** Any leg carried inferred (no-data) status. */
  inferred: boolean;
  legs: TimelineEntry[];
}

type TimelineRow =
  | { kind: "city"; city: string }
  | { kind: "entry"; entry: TimelineEntry }
  | { kind: "journey"; journey: TimelineJourney };



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

  /**
   * True when the day on screen is the one still being written.
   *
   * ⚠ A DAY-LEVEL FACT, DELIBERATELY NOT A PER-ROW ONE (#1271). Every other day
   * on this page is history; today is an inference in progress, and rows change
   * identity as data arrives — measured 2026-08-30, a `stationary place=null`
   * at 12:20 was a `train` when the same day was recomputed an hour later.
   *
   * ⚠ It is NOT the `inferred` marker's job. That says something narrower and
   * more useful — THIS row was asserted from surrounding days rather than
   * observed — and stamping a day-level caveat onto every row would drown it in
   * a hedge that is true of all of them. One note, once.
   *
   * On settled days the namer is not the problem: 184 of 184 stationary states
   * across the golden corpus are named, 34 of 36 across seven served days. So
   * this is the only place the honesty was missing.
   */
  readonly stillRecording = computed(() => this.referenceDate() === todayLocal());

  readonly rows = computed<TimelineRow[]>(() => {
    const v = this.data();
    let flat: TimelineRow[];
    if (v?.states && v.states.length > 0) {
      flat = this.buildRowsFromStates(v.states);
    } else if (!v?.segments?.length) {
      return [];
    } else {
      flat = this.buildRowsFromSegments(v.segments);
    }
    return this.applyServedJourneys(flat, v?.journeys ?? []);
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

  /** Fold the entry rows a SERVED journey spans into one collapsible row.
   *
   *  The grouping rule itself lives in the backend now
   *  (`Verified.Geo.ServedJourneys`) — this only binds its answer to rows.
   *  The client used to decide for itself which runs collapsed, which made it a
   *  second copy of a backend rule (#339) that could drift from the first. The
   *  two were measured to agree on every replayable golden day — 102 journeys
   *  each, none differing — before this replaced the copy (#230).
   *
   *  Rows are matched on the state's own `startTs`, which is why
   *  `TimelineEntry` carries one: the labels are already localised, so they
   *  cannot be compared against a span.
   *
   *  ⚠ An absent or empty `journeys` leaves every row flat rather than falling
   *  back to a local rule. That is deliberate — a second rule kept "just for
   *  the fallback" is the thing this removes — and it is what the
   *  segments-only path (no states, so no journeys) now renders. */
  private applyServedJourneys(rows: TimelineRow[], journeys: ServedJourney[]): TimelineRow[] {
    if (journeys.length === 0) return rows;
    const spanOf = (e: TimelineEntry) =>
      journeys.find((j) => e.startTs >= j.startTs && e.startTs < j.endTs);
    const out: TimelineRow[] = [];
    let journeyIdx = 0;
    let i = 0;
    while (i < rows.length) {
      const r = rows[i];
      const j = r.kind === "entry" ? spanOf(r.entry) : undefined;
      if (!j) {
        out.push(r);
        i++;
        continue;
      }
      const legs: TimelineEntry[] = [];
      while (i < rows.length) {
        const ri = rows[i];
        if (ri.kind !== "entry" || spanOf(ri.entry) !== j) break;
        legs.push(ri.entry);
        i++;
      }
      out.push({ kind: "journey", journey: this.buildJourney(legs, journeyIdx++) });
    }
    return out;
  }

  /** Assemble the collapsed summary for a run of legs. */
  private buildJourney(legs: TimelineEntry[], index: number): TimelineJourney {
    const first = legs[0];
    const last = legs[legs.length - 1];
    const totalSeconds = legs.reduce((sum, l) => sum + l.durationSeconds, 0);
    const durationLabel = this.formatDuration(totalSeconds);

    // List the transports in order by MODE only — "Train", "Bus" — not the
    // station-pair/line detail, which lives in the expanded legs. The walks
    // are implied by the icon rail, and the destination is the visit row
    // directly below, so both would be noise here. Collapse consecutive
    // same-mode legs so a train interchange reads "Train", not "Train · Train".
    const modes = legs.filter((l) => l.mode !== "walking").map((l) => modeStyle(l.mode).label);
    const transitLabels = modes.filter((m, i) => i === 0 || m !== modes[i - 1]);

    const summaryLabel =
      transitLabels.length > 0 ? `${transitLabels.join(" · ")} · ${durationLabel}` : durationLabel;

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

  private buildRowsFromStates(states: DayState[]): TimelineRow[] {
    const rows: TimelineRow[] = [];
    let lastCity: string | null = null;
    for (const state of states) {
      const city = state.city;
      if (city && city !== lastCity) {
        rows.push({ kind: "city", city });
        lastCity = city;
      }
      rows.push({ kind: "entry", entry: this.stateToEntry(state) });
    }
    return rows;
  }

  private stateToEntry(state: DayState): TimelineEntry {
    const icon = modeStyle(state.mode).icon;
    // ⚠ `state.tz` IS the segment's `displayTz` — the backend reads it straight
    // off the segment the state came from (`DayState.lean:127`), and a sleeping
    // window prefers its own zone over it (:162). The frontend used to fall back
    // to re-finding a segment by midpoint, which could not help: it searches the
    // SAME field by a NARROWER rule, so it only differs when some OTHER segment
    // covers this state's midpoint — and segments do not overlap. Measured over
    // the corpus 2026-09-11 (#339): 626 states across 41 days, none without a
    // tz. Deleted rather than kept as insurance, because a second rule for a
    // domain question is what this ticket is about.
    const tz = state.tz;
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
      const verb = modeStyle(state.mode).verb;
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
      startTs: state.startTs,
      startLabel,
      startDayOffset,
      endLabel,
      durationLabel,
      durationSeconds: state.endTs - state.startTs,
      mode: state.mode,
      icon,
      primary,
      secondary,
      inferred: !!state.inferred,
    };
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
    const icon = modeStyle(mode).icon;
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
      const verb = modeStyle(mode).verb;
      primary = `${verb} · ${s.avgSpeed} km/h`;
      if (s.wayName) {
        secondary = `On ${s.wayName} · ${durationLabel}`;
      } else {
        // ⚠ `refinedReason` USED TO BE PRINTED HERE and is not any more (#339).
        // The backend calls it display-and-debugging-only, and it reads like
        // it: "no pass could identify this ride" is a note to whoever is
        // debugging the classifier, not prose for the person whose day it is.
        // The speed line below says the same thing in their terms.
        secondary = `${durationLabel} · max ${s.maxSpeed} km/h`;
      }
    }

    return {
      startTs: s.startTs,
      startLabel,
      startDayOffset: "",
      endLabel,
      durationLabel,
      durationSeconds: s.endTs - s.startTs,
      mode,
      icon,
      primary,
      secondary,
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
