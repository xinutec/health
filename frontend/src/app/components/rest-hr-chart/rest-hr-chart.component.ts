import { Component, input, effect, ChangeDetectionStrategy, signal, inject } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { RestHrHelpComponent } from "./rest-hr-help.component";
import { BaseChartDirective } from "ng2-charts";
import { Sheets } from "@xinutec/ui-scaffold";
import type { ChartConfiguration } from "chart.js";
import type { RestHrDay } from "../../services/health.service";
import { chartColors, gridColor, tickColor, formatDay } from "../../chart-theme";

/** The day's median of settled rest blocks as a line, with the middle half
 *  (25th–75th) shaded and the 5th–95th fainter behind it, so a noisy day reads
 *  noisy rather than high. A day that could not be measured is a gap. */
@Component({
  selector: "app-rest-hr-chart",
  standalone: true,
  imports: [MatCardModule, MatButtonModule, MatIconModule, BaseChartDirective],
  templateUrl: "./rest-hr-chart.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./rest-hr-chart.component.scss",
})
export class RestHrChartComponent {
  private readonly sheets = inject(Sheets);

  openHelp(): void {
    this.sheets.open(RestHrHelpComponent);
  }

  readonly days = input<RestHrDay[]>([]);
  readonly failed = input(false);

  private static readonly PAD = 3;
  private static readonly MEDIAN = "Median";
  private static readonly MID = "25th–75th percentile";
  private static readonly WIDE = "5th–95th percentile";
  private static readonly LEGEND = [RestHrChartComponent.MEDIAN, RestHrChartComponent.MID, RestHrChartComponent.WIDE];

  readonly chartData = signal<ChartConfiguration<"line">["data"]>({ labels: [], datasets: [] });
  readonly chartOptions = signal<ChartConfiguration<"line">["options"]>(this.buildOptions(50, 90, []));

  private buildOptions(min: number, max: number, data: RestHrDay[]): ChartConfiguration<"line">["options"] {
    return {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: true,
          labels: {
            color: tickColor,
            // The band edges are drawing aids, not series.
            filter: (item) => RestHrChartComponent.LEGEND.includes(item.text),
            // From the line outwards, not in drawing order.
            sort: (a, b) => RestHrChartComponent.LEGEND.indexOf(a.text) - RestHrChartComponent.LEGEND.indexOf(b.text),
          },
        },
        tooltip: {
          filter: (item) => item.dataset.label === RestHrChartComponent.MEDIAN,
          callbacks: {
            label: (ctx) => {
              const d = data[ctx.dataIndex];
              if (!d || typeof d.median !== "number") return "not measured";
              return `${d.median.toFixed(0)} bpm (25th–75th ${d.p25?.toFixed(0)}–${d.p75?.toFixed(0)}, ${d.restMinutes} min)`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: tickColor }, grid: { display: false } },
        y: { ticks: { color: tickColor, callback: (v) => `${v}` }, grid: { color: gridColor }, min, max },
      },
    };
  }

  constructor() {
    effect(() => {
      const data = this.days();
      const measured = data.filter((d) => typeof d.median === "number");
      if (measured.length === 0) {
        this.chartData.set({ labels: [], datasets: [] });
        return;
      }
      const v = (k: keyof RestHrDay) => data.map((d) => (typeof d[k] === "number" ? d[k] : null));
      const lows = measured.map((d) => d.p05 ?? d.median!);
      const highs = measured.map((d) => d.p95 ?? d.median!);
      const lo = Math.floor(Math.min(...lows) - RestHrChartComponent.PAD);
      const hi = Math.ceil(Math.max(...highs) + RestHrChartComponent.PAD);
      this.chartOptions.set(this.buildOptions(Math.max(0, lo), hi, data));
      const edge = { borderWidth: 0, pointRadius: 0, pointHoverRadius: 0, tension: 0.3, spanGaps: false };
      this.chartData.set({
        labels: data.map((d) => formatDay(d.date)),
        datasets: [
          { ...edge, label: "p5", data: v("p05"), fill: false },
          { ...edge, label: RestHrChartComponent.WIDE, data: v("p95"), fill: "-1", backgroundColor: "rgba(239, 68, 68, 0.07)" },
          { ...edge, label: "p25", data: v("p25"), fill: false },
          { ...edge, label: RestHrChartComponent.MID, data: v("p75"), fill: "-1", backgroundColor: "rgba(239, 68, 68, 0.22)" },
          {
            label: RestHrChartComponent.MEDIAN,
            data: v("median"),
            borderColor: chartColors.red,
            backgroundColor: chartColors.red,
            fill: false,
            tension: 0.3,
            pointRadius: 3,
            spanGaps: false,
          },
        ],
      });
    });
  }
}
