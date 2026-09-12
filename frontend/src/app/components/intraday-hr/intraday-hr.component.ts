import { Component, input, effect, ChangeDetectionStrategy, signal } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { BaseChartDirective } from "ng2-charts";
import type { ChartConfiguration } from "chart.js";
import type { HeartRatePoint } from "../../services/health.service";
import { chartColors, tickColor, gridColor } from "../../chart-theme";
import { wallClockInZone } from "../../time-utils";

@Component({
  selector: "app-intraday-hr",
  standalone: true,
  imports: [MatCardModule, BaseChartDirective],
  templateUrl: './intraday-hr.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './intraday-hr.component.scss',
})
export class IntradayHrComponent {
  readonly points = input<HeartRatePoint[]>([]);

  readonly chartData = signal<ChartConfiguration<"line">["data"]>({ labels: [], datasets: [] });
  readonly chartOptions = signal<ChartConfiguration<"line">["options"]>({
    responsive: true,
    maintainAspectRatio: true,
    plugins: { legend: { display: false } },
    elements: { point: { radius: 0 } },
    scales: {
      x: {
        ticks: { color: tickColor, maxTicksLimit: 12 },
        grid: { display: false },
      },
      y: {
        ticks: { color: tickColor },
        grid: { color: gridColor },
        suggestedMin: 40,
      },
    },
  });

  constructor() {
    effect(() => {
      const data = this.points();
      if (data.length === 0) return;

      // Downsample to every 5 minutes for performance
      const sampled = data.filter((_, i) => i % 5 === 0);

      this.chartData.set({
        // The instant, put back on the clock he was living by. Reading the
        // label off a wall-clock string is what this used to do, and the API no
        // longer serves one (#1532).
        labels: sampled.map((p) => wallClockInZone(Date.parse(p.ts_utc), p.tz)),
        datasets: [{
          data: sampled.map((p) => p.bpm),
          borderColor: chartColors.red,
          backgroundColor: "rgba(239, 68, 68, 0.08)",
          fill: true,
          tension: 0.2,
          borderWidth: 1.5,
        }],
      });
    });
  }
}
