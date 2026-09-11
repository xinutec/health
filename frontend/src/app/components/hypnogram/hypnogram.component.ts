import { Component, effect, ElementRef, input, type OnDestroy, signal, viewChild, ChangeDetectionStrategy } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import type { SleepStage } from "../../services/health.service";
import { rowInstant, wallClockInZone } from "../../time-utils";

// Y positions: Awake at top, Deep at bottom
const STAGE_Y: Record<string, number> = {
  wake: 0, awake: 0,
  rem: 1, restless: 1,
  light: 2, asleep: 2,
  deep: 3,
};

const STAGE_COLORS: Record<string, string> = {
  wake: "#f472b6",   // pink
  awake: "#f472b6",
  rem: "#67e8f9",    // cyan
  restless: "#f472b6",
  light: "#60a5fa",  // blue
  asleep: "#60a5fa",
  deep: "#a78bfa",   // purple
};

const STAGE_LABELS = ["Awake", "REM", "Light", "Deep"];

@Component({
  selector: "app-hypnogram",
  standalone: true,
  imports: [MatCardModule],
  templateUrl: './hypnogram.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './hypnogram.component.scss',
})
export class HypnogramComponent implements OnDestroy {
  readonly stages = input<SleepStage[]>([]);
  readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>("canvas");
  readonly stageLabels = STAGE_LABELS;
  timeLabels = signal<string[]>([]);
  /** Bumped by the ResizeObserver to re-run the draw effect when the
   *  canvas resizes — including 0→visible after this tab is shown,
   *  which is when a day switched on another tab left it blank. */
  private readonly redrawTick = signal(0);
  private resizeObs: ResizeObserver | null = null;

  constructor() {
    effect(() => {
      this.redrawTick();
      const data = this.stages();
      const canvasEl = this.canvasRef();
      if (canvasEl && !this.resizeObs) {
        this.resizeObs = new ResizeObserver(() => this.redrawTick.update((n) => n + 1));
        this.resizeObs.observe(canvasEl.nativeElement.parentElement ?? canvasEl.nativeElement);
      }
      if (data.length === 0 || !canvasEl) return;

      const canvas = canvasEl.nativeElement;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // GEOMETRY IN TRUE INSTANTS, LABELS IN WALL CLOCK (#340).
      //
      // `ts` is the watch's wall clock wearing a "Z" the API puts on every
      // DATETIME; `ts_utc` beside it is the real instant. Doing the arithmetic
      // on `ts` used to need a repair here — strip the Z, rebuild a Date, and
      // distrust duration_seconds, because a clock shift mid-night inflates a
      // wall-clock difference (one travel night stored an 86-min "wake" where
      // only 26 was real). On instants that distortion cannot arise, so the
      // repair is gone and the stage ends are simply the next stage's start.
      //
      // ⚠ The fallback is a DEGRADATION, not a default: without `ts_utc` the
      // wall clock is read as though it were UTC, which reproduces the old
      // geometry exactly — correct on an ordinary night, wrong by the shift on
      // a night he changed zones. Measured 2026-09-11: 0 of 37718 stage rows
      // in production lack `ts_utc`, so this is for old payloads only.
      const instant = (s: SleepStage): number => rowInstant(s.ts, s.ts_utc);

      const firstTime = instant(data[0]);
      const stageEnds = data.map((s, i) =>
        i < data.length - 1 ? instant(data[i + 1]) : instant(s) + s.duration_seconds * 1000,
      );
      const totalMs = stageEnds[stageEnds.length - 1] - firstTime;

      // Set canvas size
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      const w = rect.width;
      const h = rect.height;

      // Drawing area
      const padTop = 8;
      const padBottom = 8;
      const drawH = h - padTop - padBottom;
      const laneH = drawH / 4; // 4 stages

      // Clear
      ctx.clearRect(0, 0, w, h);

      // Draw grid lines
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        const y = padTop + i * laneH + laneH / 2;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Draw each stage as a filled rectangle in its lane
      for (let i = 0; i < data.length; i++) {
        const stage = data[i];
        const stageStart = instant(stage);
        const stageEnd = stageEnds[i];

        const x1 = ((stageStart - firstTime) / totalMs) * w;
        const x2 = ((stageEnd - firstTime) / totalMs) * w;
        const level = STAGE_Y[stage.stage] ?? 2;
        const color = STAGE_COLORS[stage.stage] ?? "#60a5fa";

        const y = padTop + level * laneH + 2;
        const barH = laneH - 4;

        ctx.fillStyle = color;
        ctx.fillRect(x1, y, Math.max(x2 - x1, 1), barH);
      }

      // Draw connecting lines between stages
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.lineWidth = 1;
      for (let i = 1; i < data.length; i++) {
        const prev = data[i - 1];
        const curr = data[i];
        const prevLevel = STAGE_Y[prev.stage] ?? 2;
        const currLevel = STAGE_Y[curr.stage] ?? 2;
        if (prevLevel !== currLevel) {
          const prevEnd = stageEnds[i - 1];
          const x = ((prevEnd - firstTime) / totalMs) * w;
          const y1 = padTop + prevLevel * laneH + laneH / 2;
          const y2 = padTop + currLevel * laneH + laneH / 2;
          ctx.beginPath();
          ctx.moveTo(x, y1);
          ctx.lineTo(x, y2);
          ctx.stroke();
        }
      }

      // Time labels — the wall clock of the stage each tick lands in, so a
      // night that crossed a zone reads the way it was lived rather than the
      // way one end of it was. The ZONE does the work: asking Intl to render the
      // instant in the sleeper's zone cannot pick up the VIEWER's, and unlike a
      // fixed offset it stays right across a night he changed zones.
      const labelCount = 6;
      const labels: string[] = [];
      for (let i = 0; i <= labelCount; i++) {
        const at = firstTime + (totalMs * i) / labelCount;
        let k = 0;
        while (k < data.length - 1 && stageEnds[k] <= at) k++;
        labels.push(wallClockInZone(at, data[k].tz));
      }
      this.timeLabels.set(labels);
    });
  }

  ngOnDestroy(): void {
    this.resizeObs?.disconnect();
  }
}
