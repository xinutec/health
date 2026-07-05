import { Component, input, effect, ChangeDetectionStrategy, signal } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { BaseChartDirective } from "ng2-charts";
import type { ChartConfiguration } from "chart.js";
import type { HrvDay } from "../../services/health.service";
import { chartColors, gridColor, tickColor, formatDay } from "../../chart-theme";

@Component({
  selector: "app-hrv-chart",
  standalone: true,
  imports: [MatCardModule, BaseChartDirective],
  templateUrl: "./hrv-chart.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./hrv-chart.component.scss",
})
export class HrvChartComponent {
  readonly hrv = input<HrvDay[]>([]);

  private static readonly PAD = 2;
  private static readonly MIN_SPAN = 10;

  readonly chartData = signal<ChartConfiguration<"line">["data"]>({ labels: [], datasets: [] });
  readonly chartOptions = signal<ChartConfiguration<"line">["options"]>(this.buildOptions(0, 80));

  private buildOptions(min: number, max: number): ChartConfiguration<"line">["options"] {
    return {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: true, labels: { color: tickColor } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${(ctx.raw as number).toFixed(1)} ms` } },
      },
      scales: {
        x: { ticks: { color: tickColor }, grid: { display: false } },
        y: {
          ticks: { color: tickColor, callback: (v) => `${v} ms` },
          grid: { color: gridColor },
          min,
          max,
        },
      },
    };
  }

  constructor() {
    effect(() => {
      const data = this.hrv();
      if (data.length === 0) {
        this.chartData.set({ labels: [], datasets: [] });
        return;
      }

      const dailyVals = data.map((d) => d.daily_rmssd);
      const deepVals = data.map((d) => d.deep_rmssd);
      const allVals = [...dailyVals, ...deepVals];

      let lo = Math.floor(Math.min(...allVals) - HrvChartComponent.PAD);
      let hi = Math.ceil(Math.max(...allVals) + HrvChartComponent.PAD);
      const span = hi - lo;
      if (span < HrvChartComponent.MIN_SPAN) {
        const grow = (HrvChartComponent.MIN_SPAN - span) / 2;
        lo = Math.floor(lo - grow);
        hi = Math.ceil(hi + grow);
      }
      this.chartOptions.set(this.buildOptions(Math.max(0, lo), hi));

      this.chartData.set({
        labels: data.map((d) => formatDay(d.date)),
        datasets: [
          {
            label: "Daily RMSSD",
            data: dailyVals,
            borderColor: chartColors.purple,
            backgroundColor: "rgba(139, 92, 246, 0.1)",
            fill: true,
            tension: 0.3,
            pointRadius: 3,
          },
          {
            label: "Deep sleep RMSSD",
            data: deepVals,
            borderColor: chartColors.blue,
            backgroundColor: "rgba(59, 130, 246, 0.08)",
            fill: true,
            tension: 0.3,
            pointRadius: 3,
          },
        ],
      });
    });
  }
}
