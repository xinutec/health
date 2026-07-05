import { Component, effect, ElementRef, input, type OnDestroy, signal, viewChild, ChangeDetectionStrategy } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import type { SleepStage } from "../../services/health.service";
import { localEpoch } from "../../time-utils";

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

      // Compute time range (local time, not UTC). Each stage runs until
      // the NEXT stage begins — Fitbit's stages partition the night.
      // duration_seconds is unreliable: at a timezone boundary a watch
      // clock shift can inflate it (one travel night stored an 86-min
      // "wake" where only 26 min was real), which would draw stages
      // overlapping. Derive every stage end from the next stage's
      // start; only the final stage falls back to its own duration.
      const firstTime = localEpoch(data[0].ts);
      const stageEnds = data.map((s, i) =>
        i < data.length - 1 ? localEpoch(data[i + 1].ts) : localEpoch(s.ts) + s.duration_seconds * 1000,
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
        const stageStart = localEpoch(stage.ts);
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

      // Time labels — use formatLocalTime for first/last, interpolate for middle
      const labelCount = 6;
      // For interpolated labels, use the local epoch (already local time)
      const labels: string[] = [];
      for (let i = 0; i <= labelCount; i++) {
        const ms = firstTime + (totalMs * i) / labelCount;
        const d = new Date(ms);
        const hh = d.getHours().toString().padStart(2, "0");
        const mm = d.getMinutes().toString().padStart(2, "0");
        labels.push(`${hh}:${mm}`);
      }
      this.timeLabels.set(labels);
    });
  }

  ngOnDestroy(): void {
    this.resizeObs?.disconnect();
  }
}
