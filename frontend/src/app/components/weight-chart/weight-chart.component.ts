import { Component, effect, input, ChangeDetectionStrategy, signal } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import type { ChartConfiguration, ChartDataset } from "chart.js";
import { BaseChartDirective } from "ng2-charts";
import { chartColors, formatDay, gridColor, localDay, tickColor } from "../../chart-theme";
import type { BodyBefore, BodyDay } from "../../services/health.service";
import { dayAxis, placeOnDays, type DaySeries } from "./weight-chart.logic";

/** Suffix naming an estimate dataset; the legend hides it, the tooltip marks it. */
const ESTIMATE = "(estimate)";

@Component({
  selector: "app-weight-chart",
  standalone: true,
  imports: [MatCardModule, BaseChartDirective],
  templateUrl: "./weight-chart.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WeightChartComponent {
  readonly body = input<BodyDay[]>([]);
  readonly before = input<BodyBefore | null>(null);

  private static readonly PAD_KG = 1;
  private static readonly MIN_SPAN_KG = 4;
  /** Body fat's own axis, on the right: padded, and never narrower than this,
   *  so a 0.3-point wobble does not fill the chart's height. */
  private static readonly PAD_PCT = 1;
  private static readonly MIN_SPAN_PCT = 6;

  readonly chartData = signal<ChartConfiguration<"line">["data"]>({ labels: [], datasets: [] });
  readonly chartOptions = signal<ChartConfiguration<"line">["options"]>(this.buildOptions(60, 80, null));

  // One column per day, like the other Trends charts, so the same date sits at
  // the same x on every card. Weigh-ins are sparse, so the line spans the days
  // between them.
  private buildOptions(
    min: number,
    max: number,
    fat: { min: number; max: number } | null,
  ): ChartConfiguration<"line">["options"] {
    return {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: true,
          // The estimate lines are part of their series, not series of their own.
          labels: { color: tickColor, filter: (item) => !item.text.endsWith(ESTIMATE) },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y!.toFixed(1);
              const text = ctx.dataset.yAxisID === "fat" ? `Body fat ${v} %` : `${v} kg`;
              return ctx.dataset.label?.endsWith(ESTIMATE) ? `≈ ${text} (estimated)` : text;
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: tickColor }, grid: { display: false } },
        y: {
          ticks: { color: tickColor, callback: (v) => `${v} kg` },
          grid: { color: gridColor },
          min,
          max,
        },
        fat: {
          display: fat !== null,
          position: "right",
          ticks: { color: tickColor, callback: (v) => `${v} %` },
          grid: { display: false },
          min: fat?.min,
          max: fat?.max,
        },
      },
    };
  }

  /** Padded bounds over `vals`, never narrower than `minSpan`; null for none. */
  private static range(vals: number[], pad: number, minSpan: number): { min: number; max: number } | null {
    if (vals.length === 0) return null;
    let lo = Math.floor(Math.min(...vals) - pad);
    let hi = Math.ceil(Math.max(...vals) + pad);
    const span = hi - lo;
    if (span < minSpan) {
      const grow = (minSpan - span) / 2;
      lo = Math.floor(lo - grow);
      hi = Math.ceil(hi + grow);
    }
    return { min: Math.max(0, lo), max: hi };
  }

  /** A series as two datasets: the readings, and — when the first day is
   *  estimated — a dashed line from the hollow estimate to the first reading. */
  private static datasets(
    series: DaySeries,
    base: ChartDataset<"line">,
    color: string,
  ): ChartDataset<"line">[] {
    const readings = [...series.values];
    if (!series.estimatedFirst) return [{ ...base, data: readings }];
    const firstIdx = readings.findIndex((v, i) => i > 0 && v !== null);
    const estimate = readings.map((v, i) => (i === 0 || i === firstIdx ? v : null));
    readings[0] = null;
    return [
      { ...base, data: readings },
      {
        label: `${base.label} ${ESTIMATE}`,
        data: estimate,
        yAxisID: base.yAxisID,
        borderColor: color,
        borderDash: [4, 4],
        borderWidth: 1.5,
        fill: false,
        spanGaps: true,
        pointBackgroundColor: "transparent",
        pointBorderColor: color,
        // Only the estimate is a point; the far end is the reading's own.
        pointRadius: (ctx) => (ctx.dataIndex === 0 ? 3 : 0),
        pointHitRadius: (ctx) => (ctx.dataIndex === 0 ? 4 : 0),
      },
    ];
  }

  constructor() {
    effect(() => {
      // DECIMALs arrive as strings; coerce and drop blank or non-positive values.
      const read = (pick: (d: BodyDay) => number | string | null) =>
        this.body()
          .map((d) => ({ date: d.date.slice(0, 10), value: pick(d) == null ? Number.NaN : Number(pick(d)) }))
          .filter((r) => Number.isFinite(r.value) && r.value > 0);
      const weights = read((d) => d.weight_kg);
      const fats = read((d) => d.body_fat_pct);
      if (weights.length === 0 && fats.length === 0) {
        this.chartData.set({ labels: [], datasets: [] });
        return;
      }

      const before = this.before();
      const firstDate = [...weights, ...fats].map((r) => r.date).sort()[0];
      const days = dayAxis(before?.since ?? firstDate, localDay(new Date()));
      const weight = placeOnDays(days, weights, before?.weight ?? null);
      const fat = placeOnDays(days, fats, before?.bodyFat ?? null);

      const kgRange = WeightChartComponent.range(
        weight.values.filter((v): v is number => v !== null),
        WeightChartComponent.PAD_KG,
        WeightChartComponent.MIN_SPAN_KG,
      ) ?? { min: 60, max: 80 };
      const fatRange = WeightChartComponent.range(
        fat.values.filter((v): v is number => v !== null),
        WeightChartComponent.PAD_PCT,
        WeightChartComponent.MIN_SPAN_PCT,
      );
      this.chartOptions.set(this.buildOptions(kgRange.min, kgRange.max, fatRange));

      this.chartData.set({
        labels: days.map((d) => formatDay(d)),
        datasets: [
          ...WeightChartComponent.datasets(
            weight,
            {
              label: "Weight",
              data: [],
              borderColor: chartColors.green,
              backgroundColor: "rgba(34, 197, 94, 0.1)",
              fill: true,
              tension: 0.3,
              pointRadius: 2,
              spanGaps: true,
            },
            chartColors.green,
          ),
          ...(fatRange === null
            ? []
            : WeightChartComponent.datasets(
                fat,
                {
                  label: "Body fat",
                  data: [],
                  yAxisID: "fat",
                  borderColor: chartColors.amber,
                  backgroundColor: chartColors.amber,
                  fill: false,
                  tension: 0.3,
                  pointRadius: 2,
                  borderWidth: 1.5,
                  spanGaps: true,
                },
                chartColors.amber,
              )),
        ],
      });
    });
  }
}
