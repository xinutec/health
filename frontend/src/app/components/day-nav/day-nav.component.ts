import { Component, input, output, ChangeDetectionStrategy } from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";

/**
 * Day navigator — a `‹ date ›` control shared by the Day and Map tabs.
 *
 * Stateless: the parent owns the selected date. This component renders
 * the label and edge state it is given and emits a step (-1 for the
 * previous day, +1 for the next) when a chevron is pressed.
 */
@Component({
	selector: "app-day-nav",
	standalone: true,
	imports: [MatButtonModule, MatIconModule],
	templateUrl: "./day-nav.component.html",
	changeDetection: ChangeDetectionStrategy.OnPush,
	styleUrl: "./day-nav.component.scss",
})
export class DayNavComponent {
	readonly label = input.required<string>();
	readonly loading = input(false);
	readonly canPrev = input(false);
	readonly canNext = input(false);
	/** Emits -1 for the previous day, +1 for the next. */
	readonly navigate = output<number>();
}
