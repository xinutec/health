import { Component, input, effect, ChangeDetectionStrategy, signal } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { BaseChartDirective } from "ng2-charts";
import type { ChartConfiguration } from "chart.js";
import type { ActivityDay } from "../../services/health.service";
import { chartColors, gridColor, tickColor, formatDay } from "../../chart-theme";

@Component({
  selector: "app-heartrate-chart",
  standalone: true,
  imports: [MatCardModule, BaseChartDirective],
  templateUrl: './heartrate-chart.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './heartrate-chart.component.scss',
})
export class HeartrateChartComponent {
  readonly activity = input<ActivityDay[]>([]);

  /** Padding (bpm) above/below the data so the line isn't flush against
   *  the axis. */
  private static readonly PAD = 3;
  /** Minimum y-axis span (bpm). Resting HR is stable, so without a floor
   *  a near-flat week would zoom in until 1-bpm sensor noise looked like a
   *  dramatic swing. ~15 bpm keeps real trends visible without crying wolf. */
  private static readonly MIN_SPAN = 15;

  readonly chartData = signal<ChartConfiguration<"line">["data"]>({ labels: [], datasets: [] });
  readonly chartOptions = signal<ChartConfiguration<"line">["options"]>(this.buildOptions(50, 90));

  /** Fit the y-axis to [lo, hi] rather than a fixed 50–90 band, so the
   *  actual resting-HR variation fills the chart. */
  private buildOptions(min: number, max: number): ChartConfiguration<"line">["options"] {
    return {
      responsive: true,
      maintainAspectRatio: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: tickColor }, grid: { display: false } },
        y: { ticks: { color: tickColor }, grid: { color: gridColor }, min, max },
      },
    };
  }

  constructor() {
    effect(() => {
      const data = this.activity().filter((d) => d.resting_heart_rate != null);
      const values = data.map((d) => d.resting_heart_rate!);

      if (values.length > 0) {
        let lo = Math.floor(Math.min(...values) - HeartrateChartComponent.PAD);
        let hi = Math.ceil(Math.max(...values) + HeartrateChartComponent.PAD);
        const span = hi - lo;
        if (span < HeartrateChartComponent.MIN_SPAN) {
          const grow = (HeartrateChartComponent.MIN_SPAN - span) / 2;
          lo = Math.floor(lo - grow);
          hi = Math.ceil(hi + grow);
        }
        this.chartOptions.set(this.buildOptions(lo, hi));
      }

      this.chartData.set({
        labels: data.map((d) => formatDay(d.date)),
        datasets: [{
          data: values,
          borderColor: chartColors.red,
          backgroundColor: "rgba(239, 68, 68, 0.1)",
          fill: true,
          tension: 0.3,
          pointRadius: 3,
        }],
      });
    });
  }
}
