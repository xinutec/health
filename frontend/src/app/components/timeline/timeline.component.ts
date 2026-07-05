import { Component, computed, input, ChangeDetectionStrategy } from "@angular/core";
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
  mode: string;
  icon: string;
  primary: string;
  secondary?: string;
}

type TimelineRow = { kind: "city"; city: string } | { kind: "entry"; entry: TimelineEntry };

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

@Component({
  selector: "app-timeline",
  standalone: true,
  imports: [MatCardModule, MatIconModule],
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
    if (v?.states && v.states.length > 0) {
      return this.buildRowsFromStates(v.states, v.segments ?? []);
    }
    if (!v?.segments?.length) return [];
    return this.buildRowsFromSegments(v.segments);
  });

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

    return { startLabel, startDayOffset, endLabel, durationLabel, mode: state.mode, icon, primary, secondary };
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

    return { startLabel, startDayOffset: "", endLabel, durationLabel, mode, icon, primary, secondary };
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
