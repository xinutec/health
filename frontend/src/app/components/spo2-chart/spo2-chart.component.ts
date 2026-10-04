import { Component, input, effect, ChangeDetectionStrategy, signal } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { BaseChartDirective } from "ng2-charts";
import type { ChartConfiguration } from "chart.js";
import type { Spo2Day } from "../../services/health.service";
import { chartColors, gridColor, tickColor, formatDay } from "../../chart-theme";

/** A DECIMAL off the wire (a string), or a gap. */
const pct = (v: number | string | null): number | null => {
  const n = v == null ? Number.NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

@Component({
  selector: "app-spo2-chart",
  standalone: true,
  imports: [MatCardModule, BaseChartDirective],
  templateUrl: "./spo2-chart.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Spo2ChartComponent {
  readonly spo2 = input<Spo2Day[]>([]);

  private static readonly PAD = 1;
  private static readonly MIN_SPAN = 4;

  readonly chartData = signal<ChartConfiguration<"line">["data"]>({ labels: [], datasets: [] });
  readonly chartOptions = signal<ChartConfiguration<"line">["options"]>(this.buildOptions(90, 100));

  private buildOptions(min: number, max: number): ChartConfiguration<"line">["options"] {
    return {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: true, labels: { color: tickColor } },
        // A gap is `null`; `.toFixed` on it would throw inside the tooltip.
        tooltip: {
          callbacks: {
            label: (ctx) =>
              typeof ctx.raw === "number"
                ? `${ctx.dataset.label}: ${ctx.raw.toFixed(1)}%`
                : `${ctx.dataset.label}: —`,
          },
        },
      },
      scales: {
        x: { ticks: { color: tickColor }, grid: { display: false } },
        y: {
          ticks: { color: tickColor, callback: (v) => `${v}%` },
          grid: { color: gridColor },
          min,
          max,
        },
      },
    };
  }

  constructor() {
    effect(() => {
      const data = this.spo2();
      const avgVals = data.map((d) => pct(d.avg_value));
      const minVals = data.map((d) => pct(d.min_value));
      const maxVals = data.map((d) => pct(d.max_value));
      const allVals = [...avgVals, ...minVals, ...maxVals].filter((v): v is number => v != null);
      if (allVals.length === 0) {
        this.chartData.set({ labels: [], datasets: [] });
        return;
      }

      let lo = Math.floor(Math.min(...allVals) - Spo2ChartComponent.PAD);
      // Saturation tops out at 100%; the axis need not go past it.
      const hi = Math.min(100, Math.ceil(Math.max(...allVals) + Spo2ChartComponent.PAD));
      const span = hi - lo;
      if (span < Spo2ChartComponent.MIN_SPAN) lo = hi - Spo2ChartComponent.MIN_SPAN;
      // An even floor keeps Chart.js's two-point steps landing on 100.
      lo = Math.floor(lo / 2) * 2;
      this.chartOptions.set(this.buildOptions(Math.max(0, lo), hi));

      // Max fills down to min (`+1`): the night's range as a band around the average.
      this.chartData.set({
        labels: data.map((d) => formatDay(d.date)),
        datasets: [
          {
            label: "Average",
            data: avgVals,
            borderColor: chartColors.red,
            backgroundColor: chartColors.red,
            fill: false,
            tension: 0.3,
            pointRadius: 3,
            spanGaps: true,
          },
          {
            label: "Max",
            data: maxVals,
            borderColor: "rgba(239, 68, 68, 0.35)",
            backgroundColor: "rgba(239, 68, 68, 0.12)",
            borderWidth: 1,
            fill: "+1",
            tension: 0.3,
            pointRadius: 0,
            spanGaps: true,
          },
          {
            label: "Min",
            data: minVals,
            borderColor: "rgba(239, 68, 68, 0.35)",
            backgroundColor: "rgba(239, 68, 68, 0.12)",
            borderWidth: 1,
            fill: false,
            tension: 0.3,
            pointRadius: 0,
            spanGaps: true,
          },
        ],
      });
    });
  }
}
