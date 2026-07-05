import { Component, input, effect, ChangeDetectionStrategy, signal } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { BaseChartDirective } from "ng2-charts";
import type { ChartConfiguration } from "chart.js";
import type { SleepLog } from "../../services/health.service";
import { chartColors, gridColor, tickColor, formatDay } from "../../chart-theme";

@Component({
  selector: "app-sleep-chart",
  standalone: true,
  imports: [MatCardModule, BaseChartDirective],
  templateUrl: './sleep-chart.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './sleep-chart.component.scss',
})
export class SleepChartComponent {
  readonly sleep = input<SleepLog[]>([]);

  readonly chartData = signal<ChartConfiguration<"bar">["data"]>({ labels: [], datasets: [] });
  readonly chartOptions = signal<ChartConfiguration<"bar">["options"]>({
    responsive: true,
    maintainAspectRatio: true,
    plugins: {
      legend: { labels: { color: tickColor } },
    },
    scales: {
      x: { stacked: true, ticks: { color: tickColor }, grid: { display: false } },
      y: {
        stacked: true,
        ticks: { color: tickColor, callback: (v) => `${v}h` },
        grid: { color: gridColor },
      },
    },
  });

  constructor() {
    effect(() => {
      const main = this.sleep().filter((s) => s.is_main_sleep);
      const toHours = (mins: number | null) => (mins ?? 0) / 60;

      this.chartData.set({
        labels: main.map((s) => formatDay(s.date)),
        datasets: [
          { label: "Deep", data: main.map((s) => toHours(s.minutes_deep)), backgroundColor: chartColors.deepBlue, borderRadius: 2 },
          { label: "Light", data: main.map((s) => toHours(s.minutes_light)), backgroundColor: chartColors.blue, borderRadius: 2 },
          { label: "REM", data: main.map((s) => toHours(s.minutes_rem)), backgroundColor: chartColors.purple, borderRadius: 2 },
          { label: "Awake", data: main.map((s) => toHours(s.minutes_wake)), backgroundColor: chartColors.amber, borderRadius: 2 },
        ],
      });
    });
  }
}
