import { Component, effect, ElementRef, input, type OnDestroy, signal, viewChild, ChangeDetectionStrategy } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { displayTzAt, type VelocityData } from "../../services/health.service";

const MODE_COLORS: Record<string, string> = {
	stationary: "rgba(120, 120, 120, 0.2)",
	walking: "rgba(34, 197, 94, 0.25)",
	cycling: "rgba(59, 130, 246, 0.25)",
	driving: "rgba(249, 115, 22, 0.25)",
	bus: "rgba(234, 88, 12, 0.25)",
	train: "rgba(168, 85, 247, 0.25)",
	plane: "rgba(236, 72, 153, 0.25)",
};

const MODE_LABELS: Record<string, string> = {
	stationary: "Still",
	walking: "Walking",
	cycling: "Cycling",
	driving: "Driving",
	bus: "Bus",
	train: "Train",
	plane: "Plane",
};

@Component({
	selector: "app-speed-chart",
	standalone: true,
	imports: [MatCardModule],
	templateUrl: './speed-chart.component.html',
	changeDetection: ChangeDetectionStrategy.OnPush,
	styleUrl: './speed-chart.component.scss',
})
export class SpeedChartComponent implements OnDestroy {
	readonly data = input<VelocityData | null>(null);
	readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>("canvas");
	timeLabels = signal<string[]>([]);
	uniqueModes = signal<string[]>([]);
	/** Bumped by the ResizeObserver to re-run the draw effect when the
	 *  canvas resizes — including 0→visible after this tab is shown,
	 *  which is when a day switched on another tab left it blank. */
	private readonly redrawTick = signal(0);
	private resizeObs: ResizeObserver | null = null;

	constructor() {
		effect(() => {
			this.redrawTick();
			const vel = this.data();
			const canvasEl = this.canvasRef();
			if (canvasEl && !this.resizeObs) {
				this.resizeObs = new ResizeObserver(() => this.redrawTick.update((n) => n + 1));
				this.resizeObs.observe(canvasEl.nativeElement.parentElement ?? canvasEl.nativeElement);
			}
			if (!vel || vel.points.length === 0 || !canvasEl) return;

			const canvas = canvasEl.nativeElement;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;

			const points = vel.points;
			const segments = vel.segments;

			const firstTs = points[0].ts;
			const lastTs = points[points.length - 1].ts;
			const totalDuration = lastTs - firstTs || 1;

			// Find max speed for Y scale
			const maxSpeed = Math.max(20, ...points.map((p) => p.speed_kmh));

			// Set canvas size
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
			const drawW = w - padLeft;
			const drawH = h - padTop - padBottom;

			const xPos = (ts: number) => padLeft + ((ts - firstTs) / totalDuration) * drawW;
			const yPos = (speed: number) => padTop + drawH - (speed / maxSpeed) * drawH;

			// Clear
			ctx.clearRect(0, 0, w, h);

			// Draw segment background bands
			const modesSet = new Set<string>();
			for (const seg of segments) {
				const x1 = xPos(seg.startTs);
				const x2 = xPos(seg.endTs);
				ctx.fillStyle = MODE_COLORS[seg.mode] ?? MODE_COLORS["stationary"];
				ctx.fillRect(x1, padTop, x2 - x1, drawH);
				modesSet.add(seg.mode);
			}
			this.uniqueModes.set([...modesSet]);

			// Draw Y-axis grid lines and labels
			ctx.strokeStyle = "rgba(255,255,255,0.08)";
			ctx.fillStyle = "rgba(255,255,255,0.4)";
			ctx.font = "11px sans-serif";
			ctx.textAlign = "right";
			const ySteps = maxSpeed > 100 ? 50 : maxSpeed > 30 ? 10 : 5;
			for (let s = 0; s <= maxSpeed; s += ySteps) {
				const y = yPos(s);
				ctx.beginPath();
				ctx.moveTo(padLeft, y);
				ctx.lineTo(w, y);
				ctx.stroke();
				ctx.fillText(`${s}`, padLeft - 4, y + 4);
			}

			// Draw speed line
			ctx.strokeStyle = "#e2e8f0";
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			for (let i = 0; i < points.length; i++) {
				const x = xPos(points[i].ts);
				const y = yPos(points[i].speed_kmh);
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.stroke();

			// Time labels — rendered in each label instant's covering-segment
			// displayTz ("as experienced", same rule as the timeline), so the
			// chart and the narrative never disagree on a travel day.
			const labelCount = 6;
			const labels: string[] = [];
			for (let i = 0; i <= labelCount; i++) {
				const ts = firstTs + (totalDuration * i) / labelCount;
				const d = new Date(ts * 1000);
				let label: string;
				try {
					label = d.toLocaleTimeString("en-GB", {
						hour: "2-digit",
						minute: "2-digit",
						timeZone: displayTzAt(segments, ts),
					});
				} catch {
					label = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
				}
				labels.push(label);
			}
			this.timeLabels.set(labels);
		});
	}

	ngOnDestroy(): void {
		this.resizeObs?.disconnect();
	}

	modeColor(mode: string): string {
		return (MODE_COLORS[mode] ?? MODE_COLORS["stationary"]).replace(/[\d.]+\)$/, "0.6)");
	}

	modeLabel(mode: string): string {
		return MODE_LABELS[mode] ?? mode;
	}
}
