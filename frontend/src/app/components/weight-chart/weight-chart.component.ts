import { Component, effect, input, ChangeDetectionStrategy, signal } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import type { ChartConfiguration } from "chart.js";
import { BaseChartDirective } from "ng2-charts";
import { chartColors, formatDay, gridColor, tickColor } from "../../chart-theme";
import type { BodyDay } from "../../services/health.service";

@Component({
  selector: "app-weight-chart",
  standalone: true,
  imports: [MatCardModule, BaseChartDirective],
  templateUrl: "./weight-chart.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./weight-chart.component.scss",
})
export class WeightChartComponent {
  readonly body = input<BodyDay[]>([]);

  private static readonly PAD_KG = 1;
  private static readonly MIN_SPAN_KG = 4;

  readonly chartData = signal<ChartConfiguration<"line">["data"]>({ datasets: [] });
  readonly chartOptions = signal<ChartConfiguration<"line">["options"]>(this.buildOptions(60, 80));

  // Weigh-ins are sparse and irregular, so the x-axis is a real *linear* time
  // scale keyed on the date (epoch ms) — horizontal distance = elapsed time, so
  // a multi-week gap reads as a gap and clustered daily weigh-ins bunch up.
  // (The other trend charts are daily/contiguous, so they use a category axis.)
  private buildOptions(min: number, max: number): ChartConfiguration<"line">["options"] {
    const fmt = (ms: number) => formatDay(new Date(ms).toISOString().slice(0, 10));
    return {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: true, labels: { color: tickColor } },
        tooltip: {
          callbacks: {
            title: (items) => {
              const x = items[0]?.parsed.x;
              return x == null ? "" : fmt(x);
            },
            label: (ctx) => `${(ctx.parsed.y!).toFixed(1)} kg`,
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          ticks: { color: tickColor, maxTicksLimit: 6, callback: (v) => fmt(v as number) },
          grid: { display: false },
        },
        y: {
          ticks: { color: tickColor, callback: (v) => `${v} kg` },
          grid: { color: gridColor },
          min,
          max,
        },
      },
    };
  }

  constructor() {
    effect(() => {
      // Weight is a DECIMAL (string off the wire); coerce and drop blank days.
      const pts = this.body()
        .map((d) => ({ x: Date.parse(d.date), kg: d.weight_kg == null ? Number.NaN : Number(d.weight_kg) }))
        .filter((d) => Number.isFinite(d.kg) && d.kg > 0 && Number.isFinite(d.x))
        .sort((a, b) => a.x - b.x);

      if (pts.length === 0) {
        this.chartData.set({ datasets: [] });
        return;
      }

      const vals = pts.map((d) => d.kg);
      let lo = Math.floor(Math.min(...vals) - WeightChartComponent.PAD_KG);
      let hi = Math.ceil(Math.max(...vals) + WeightChartComponent.PAD_KG);
      const span = hi - lo;
      if (span < WeightChartComponent.MIN_SPAN_KG) {
        const grow = (WeightChartComponent.MIN_SPAN_KG - span) / 2;
        lo = Math.floor(lo - grow);
        hi = Math.ceil(hi + grow);
      }
      this.chartOptions.set(this.buildOptions(Math.max(0, lo), hi));

      this.chartData.set({
        datasets: [
          {
            label: "Weight",
            data: pts.map((d) => ({ x: d.x, y: d.kg })),
            borderColor: chartColors.green,
            backgroundColor: "rgba(34, 197, 94, 0.1)",
            fill: true,
            tension: 0.3,
            pointRadius: 2,
          },
        ],
      });
    });
  }
}
