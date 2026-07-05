import { Component, computed, input, ChangeDetectionStrategy } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import type { ActivityDay, SleepLog } from "../../services/health.service";

const DASH = "—";

@Component({
	selector: "app-summary-cards",
	standalone: true,
	imports: [MatCardModule],
	templateUrl: "./summary-cards.component.html",
	changeDetection: ChangeDetectionStrategy.OnPush,
	styleUrl: "./summary-cards.component.scss",
})
export class SummaryCardsComponent {
	readonly latestActivity = input<ActivityDay | null>(null);
	readonly latestSleep = input<SleepLog | null>(null);

	private readonly numberFmt = new Intl.NumberFormat();

	readonly steps = computed(() => this.fmtInt(this.latestActivity()?.steps));
	readonly restingHr = computed(() => this.fmtInt(this.latestActivity()?.resting_heart_rate));
	readonly activeMinutes = computed(() => {
		const a = this.latestActivity();
		if (!a) return DASH;
		const fa = a.minutes_fairly_active;
		const va = a.minutes_very_active;
		if (fa == null && va == null) return DASH;
		return this.numberFmt.format((fa ?? 0) + (va ?? 0));
	});
	readonly calories = computed(() => this.fmtInt(this.latestActivity()?.calories_total));
	readonly sleep = computed(() => this.fmtMinutes(this.latestSleep()?.minutes_asleep));
	readonly sleepEfficiency = computed(() => this.fmtInt(this.latestSleep()?.efficiency));

	private fmtInt(n: number | null | undefined): string {
		return n == null ? DASH : this.numberFmt.format(n);
	}

	private fmtMinutes(mins: number | null | undefined): string {
		if (mins == null) return DASH;
		const hours = Math.floor(mins / 60);
		const m = mins % 60;
		return `${hours}h ${m}m`;
	}
}
