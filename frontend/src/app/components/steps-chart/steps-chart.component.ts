import { Component, input, effect, ChangeDetectionStrategy, signal } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { BaseChartDirective } from "ng2-charts";
import type { ChartConfiguration } from "chart.js";
import type { ActivityDay } from "../../services/health.service";
import { chartColors, gridColor, tickColor } from "../../chart-theme";

@Component({
  selector: "app-steps-chart",
  standalone: true,
  imports: [MatCardModule, BaseChartDirective],
  templateUrl: './steps-chart.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './steps-chart.component.scss',
})
export class StepsChartComponent {
  readonly activity = input<ActivityDay[]>([]);

  readonly chartData = signal<ChartConfiguration<"bar">["data"]>({ labels: [], datasets: [] });
  readonly chartOptions = signal<ChartConfiguration<"bar">["options"]>({
    responsive: true,
    maintainAspectRatio: true,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: tickColor }, grid: { display: false } },
      y: { ticks: { color: tickColor }, grid: { color: gridColor } },
    },
  });

  constructor() {
    effect(() => {
      const data = this.activity();
      this.chartData.set({
        labels: data.map((d) => formatDay(d.date)),
        datasets: [{
          data: data.map((d) => d.steps),
          backgroundColor: chartColors.primary,
          borderRadius: 3,
        }],
      });
    });
  }
}

function formatDay(date: string): string {
  return new Date(date).toLocaleDateString("en", { month: "short", day: "numeric" });
}
