import { ChangeDetectionStrategy, Component, ElementRef, type OnDestroy, effect, input, signal, viewChild } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import type { BatterySample, VelocityData } from "../../services/health.service";
import { browserTimezone } from "../../time-utils";
import { batteryMarker, batteryTimeLabels, batteryXRangeMulti } from "./battery-chart.logic";

/** Phone color (PhoneTrack series) + watch color (Fitbit device series). */
const PHONE_COLOR = "#22c55e";
const WATCH_COLOR = "#3b82f6";

/** Phone- and watch-battery level over the day, on one shared axis. The phone
 *  series comes from the `battery` field PhoneTrack records on each GPS fix; the
 *  watch series is one point per Fitbit device sync (`device_battery_log`).
 *  Canvas rendering mirrors the speed chart — same hi-DPI sizing and
 *  ResizeObserver redraw so a day switched on a hidden tab still paints when the
 *  tab is shown. */
@Component({
	selector: "app-battery-chart",
	standalone: true,
	imports: [MatCardModule],
	templateUrl: "./battery-chart.component.html",
	changeDetection: ChangeDetectionStrategy.OnPush,
	styleUrl: "./battery-chart.component.scss",
})
export class BatteryChartComponent implements OnDestroy {
	readonly data = input<VelocityData | null>(null);
	readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>("canvas");
	timeLabels = signal<string[]>([]);
	readonly phoneColor = PHONE_COLOR;
	readonly watchColor = WATCH_COLOR;

	/** Bumped by the ResizeObserver to re-run the draw effect when the
	 *  canvas resizes — including 0→visible after this tab is shown. */
	private readonly redrawTick = signal(0);
	private resizeObs: ResizeObserver | null = null;

	/** True once `data()` has resolved to a non-empty series (phone OR watch) —
	 *  drives the "no data" placeholder vs the canvas in the template. */
	hasData = signal(false);
	/** Whether the watch series has any points — drives the legend's watch row. */
	hasWatch = signal(false);

	constructor() {
		effect(() => {
			this.redrawTick();
			const phone = this.data()?.battery ?? [];
			const watch = this.data()?.watchBattery ?? [];
			this.hasData.set(phone.length > 0 || watch.length > 0);
			this.hasWatch.set(watch.length > 0);
			const canvasEl = this.canvasRef();
			if (canvasEl && !this.resizeObs) {
				this.resizeObs = new ResizeObserver(() => this.redrawTick.update((n) => n + 1));
				this.resizeObs.observe(canvasEl.nativeElement.parentElement ?? canvasEl.nativeElement);
			}
			if (!this.hasData() || !canvasEl) return;

			const canvas = canvasEl.nativeElement;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;

			const range = batteryXRangeMulti([phone, watch]);
			if (!range) return;
			const { firstTs, lastTs, totalDuration } = range;

			const dpr = window.devicePixelRatio || 1;
			const rect = canvas.getBoundingClientRect();
			canvas.width = rect.width * dpr;
			canvas.height = rect.height * dpr;
			ctx.scale(dpr, dpr);
			const w = rect.width;
			const h = rect.height;

			const padTop = 20;
			const padBottom = 8;
			const padLeft = 40;
			// Headroom on the right so the end-of-day "NN%" label fits.
			const padRight = 34;
			const drawW = w - padLeft - padRight;
			const drawH = h - padTop - padBottom;

			const xPos = (ts: number): number => padLeft + ((ts - firstTs) / totalDuration) * drawW;
			// Battery is a percentage — the Y axis is always a fixed 0–100.
			const yPos = (level: number): number => padTop + drawH - (level / 100) * drawH;

			ctx.clearRect(0, 0, w, h);

			// Y-axis grid lines + labels at every 25%.
			ctx.strokeStyle = "rgba(255,255,255,0.08)";
			ctx.fillStyle = "rgba(255,255,255,0.4)";
			ctx.font = "11px sans-serif";
			ctx.textAlign = "right";
			for (let level = 0; level <= 100; level += 25) {
				const y = yPos(level);
				ctx.beginPath();
				ctx.moveTo(padLeft, y);
				ctx.lineTo(w - padRight, y);
				ctx.stroke();
				ctx.fillText(`${level}`, padLeft - 4, y + 4);
			}

			/** Draw one series: an optional fill under the line, the line, and a
			 *  dot + "NN%" label at its last reading. */
			const drawSeries = (series: readonly BatterySample[], color: string, fill: string | null): void => {
				if (series.length === 0) return;
				if (fill) {
					ctx.beginPath();
					for (let i = 0; i < series.length; i++) {
						const x = xPos(series[i].ts);
						const y = yPos(series[i].level);
						if (i === 0) ctx.moveTo(x, y);
						else ctx.lineTo(x, y);
					}
					ctx.lineTo(xPos(series[series.length - 1].ts), yPos(0));
					ctx.lineTo(xPos(series[0].ts), yPos(0));
					ctx.closePath();
					ctx.fillStyle = fill;
					ctx.fill();
				}

				ctx.strokeStyle = color;
				ctx.lineWidth = 1.75;
				ctx.lineJoin = "round";
				ctx.beginPath();
				for (let i = 0; i < series.length; i++) {
					const x = xPos(series[i].ts);
					const y = yPos(series[i].level);
					if (i === 0) ctx.moveTo(x, y);
					else ctx.lineTo(x, y);
				}
				ctx.stroke();

				const last = batteryMarker(series) ?? series[series.length - 1];
				const lx = xPos(last.ts);
				const ly = yPos(last.level);
				ctx.fillStyle = color;
				ctx.beginPath();
				ctx.arc(lx, ly, 3, 0, Math.PI * 2);
				ctx.fill();
				ctx.textAlign = "left";
				ctx.font = "12px sans-serif";
				ctx.fillText(`${last.level}%`, Math.min(lx + 6, w - padRight + 2), ly + 4);
			};

			// Phone keeps its filled area; the watch rides on top as a plain line
			// so the two are distinguishable where they overlap.
			drawSeries(phone, PHONE_COLOR, "rgba(34, 197, 94, 0.14)");
			drawSeries(watch, WATCH_COLOR, null);

			// Time labels along the X axis (timestamps are absolute epoch; render
			// in the viewer's local time zone).
			this.timeLabels.set(batteryTimeLabels(firstTs, lastTs, 6, browserTimezone()));
		});
	}

	ngOnDestroy(): void {
		this.resizeObs?.disconnect();
	}
}
