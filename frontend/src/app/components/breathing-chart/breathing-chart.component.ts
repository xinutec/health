import { Component, input, effect, ChangeDetectionStrategy, signal } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { BaseChartDirective } from "ng2-charts";
import type { ChartConfiguration } from "chart.js";
import type { BreathingDay } from "../../services/health.service";
import { chartColors, gridColor, tickColor, formatDay } from "../../chart-theme";

/** A DECIMAL off the wire (a string), or a gap. */
const rate = (v: number | string | null): number | null => {
  const n = v == null ? Number.NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

@Component({
  selector: "app-breathing-chart",
  standalone: true,
  imports: [MatCardModule, BaseChartDirective],
  templateUrl: "./breathing-chart.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BreathingChartComponent {
  readonly breathing = input<BreathingDay[]>([]);

  private static readonly PAD = 1;
  private static readonly MIN_SPAN = 4;

  readonly chartData = signal<ChartConfiguration<"line">["data"]>({ labels: [], datasets: [] });
  readonly chartOptions = signal<ChartConfiguration<"line">["options"]>(this.buildOptions(10, 20));

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
                ? `${ctx.dataset.label}: ${ctx.raw.toFixed(1)} /min`
                : `${ctx.dataset.label}: —`,
          },
        },
      },
      scales: {
        x: { ticks: { color: tickColor }, grid: { display: false } },
        y: {
          ticks: { color: tickColor, callback: (v) => `${v} /min` },
          grid: { color: gridColor },
          min,
          max,
        },
      },
    };
  }

  constructor() {
    effect(() => {
      const data = this.breathing();
      const fullVals = data.map((d) => rate(d.full_sleep_rate));
      const stages = [
        // The Sleep chart's stage colours; its deep navy is lifted to read as a line.
        { label: "Deep", vals: data.map((d) => rate(d.deep_sleep_rate)), color: "#4a6fa5" },
        { label: "Light", vals: data.map((d) => rate(d.light_sleep_rate)), color: chartColors.blue },
        { label: "REM", vals: data.map((d) => rate(d.rem_sleep_rate)), color: chartColors.purple },
      ];
      const allVals = [fullVals, ...stages.map((st) => st.vals)]
        .flat()
        .filter((v): v is number => v != null);
      if (allVals.length === 0) {
        this.chartData.set({ labels: [], datasets: [] });
        return;
      }

      let lo = Math.floor(Math.min(...allVals) - BreathingChartComponent.PAD);
      let hi = Math.ceil(Math.max(...allVals) + BreathingChartComponent.PAD);
      const span = hi - lo;
      if (span < BreathingChartComponent.MIN_SPAN) {
        const grow = (BreathingChartComponent.MIN_SPAN - span) / 2;
        lo = Math.floor(lo - grow);
        hi = Math.ceil(hi + grow);
      }
      this.chartOptions.set(this.buildOptions(Math.max(0, lo), hi));

      this.chartData.set({
        labels: data.map((d) => formatDay(d.date)),
        datasets: [
          // Overall is Google's daily figure, not an average of the stages.
          {
            label: "Overall",
            data: fullVals,
            borderColor: chartColors.amber,
            backgroundColor: "rgba(245, 158, 11, 0.1)",
            fill: true,
            tension: 0.3,
            pointRadius: 3,
            spanGaps: true,
          },
          ...stages.map((st) => ({
            label: st.label,
            data: st.vals,
            borderColor: st.color,
            backgroundColor: st.color,
            borderWidth: 1.5,
            fill: false,
            tension: 0.3,
            pointRadius: 2,
            spanGaps: true,
          })),
        ],
      });
    });
  }
}
