import { Component, OnInit, inject, signal, ChangeDetectionStrategy } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatSnackBar, MatSnackBarModule } from "@angular/material/snack-bar";
import { MatTooltipModule } from "@angular/material/tooltip";
import { RouterLink } from "@angular/router";
import { HealthService } from "../../services/health.service";

/**
 * Settings page. Today: just the share-link section.
 *
 * One token per user. "Generate new link" rotates (DELETE + INSERT
 * atomic server-side) — the previous URL stops working the instant
 * the new one is shown. "Revoke" removes the row.
 *
 * Material-first: the URL display is a real `<mat-form-field>` with
 * a `matSuffix` copy button so theming, focus, and contrast all
 * come from Material's tokens (no hand-rolled CSS for the input
 * shell). Copy confirmation uses MatSnackBar instead of a
 * label-swap on the button — transient feedback is exactly what
 * the snack-bar is for.
 */
@Component({
	selector: "app-settings",
	standalone: true,
	imports: [
		FormsModule,
		MatButtonModule,
		MatCardModule,
		MatFormFieldModule,
		MatIconModule,
		MatInputModule,
		MatProgressSpinnerModule,
		MatSnackBarModule,
		MatTooltipModule,
		RouterLink,
	],
	templateUrl: "./settings.component.html",
	changeDetection: ChangeDetectionStrategy.OnPush,
	styleUrl: "./settings.component.scss",
})
export class SettingsComponent implements OnInit {
	readonly health = inject(HealthService);
	private readonly snackBar = inject(MatSnackBar);
	readonly loading = signal(true);
	readonly error = signal<string | null>(null);
	daysInput = 7;
	/** Editable day-window for an ALREADY-active share — seeded from the
	 *  loaded status so "Update days" can change it without rotating. */
	readonly editDays = signal(7);

	async ngOnInit(): Promise<void> {
		await this.refresh();
	}

	async refresh(): Promise<void> {
		this.error.set(null);
		this.loading.set(true);
		try {
			await this.health.refreshShareStatus();
			const s = this.health.shareStatus();
			if (s?.active && typeof s.daysBack === "number") this.editDays.set(s.daysBack);
		} catch (e) {
			this.error.set((e as Error).message);
		} finally {
			this.loading.set(false);
		}
	}

	async create(): Promise<void> {
		this.error.set(null);
		try {
			await this.health.createOrRotateShare(this.daysInput);
		} catch (e) {
			this.error.set((e as Error).message);
		}
	}

	async rotate(currentDays: number): Promise<void> {
		this.error.set(null);
		try {
			await this.health.createOrRotateShare(currentDays);
		} catch (e) {
			this.error.set((e as Error).message);
		}
	}

	/** Change how many days the existing share exposes — same link. */
	async updateDays(): Promise<void> {
		this.error.set(null);
		try {
			await this.health.updateShareDays(this.editDays());
			this.snackBar.open("Share window updated", "Dismiss", { duration: 2000 });
		} catch (e) {
			this.error.set((e as Error).message);
		}
	}

	async revoke(): Promise<void> {
		this.error.set(null);
		try {
			await this.health.revokeShare();
		} catch (e) {
			this.error.set((e as Error).message);
		}
	}

	async copyLink(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			this.snackBar.open("Link copied", "Dismiss", { duration: 2000 });
		} catch {
			this.snackBar.open("Could not copy — select and copy manually.", "Dismiss", { duration: 4000 });
		}
	}

	formatDate(iso: string): string {
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}
}
