import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from "@angular/material/dialog";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { HealthService, type PlaceCandidate } from "../../services/health.service";

export interface PlacePickerData {
  lat: number;
  lon: number;
  startTs: number;
  endTs: number;
  tz: string;
  /** What the pipeline currently calls this stay. */
  current: string;
}

/**
 * "Which of these is it?" — the last step, after the sensors have said
 * everything they honestly can.
 *
 * Some venue ties cannot be broken by any amount of GPS. Sitting in Urban Social
 * on Upper Street, OSM maps the café as a bare node and the pub sharing its
 * building as a way, 13 m apart, both plausible for a midday hour. The fixes are
 * excellent — 3–8 m — and they still cannot separate the two, because the indoor
 * error runs across the street, the very axis that would tell them apart. The
 * scorer narrows the field to the pair and then stops.
 *
 * So we show what it weighed, in its own order, with its own numbers, and let
 * the user say. The scores are on display deliberately: a near-tie should LOOK
 * like a near-tie, so it is obvious the model is not being overruled so much as
 * finished.
 */
@Component({
  selector: "app-place-picker",
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule],
  templateUrl: "./place-picker.component.html",
  styleUrl: "./place-picker.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlacePickerComponent {
  private readonly health = inject(HealthService);
  private readonly dialogRef = inject(MatDialogRef<PlacePickerComponent, string | null>);
  readonly data = inject<PlacePickerData>(MAT_DIALOG_DATA);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly candidates = signal<PlaceCandidate[]>([]);
  readonly confirmed = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    const res = await this.health.placeCandidates(
      this.data.lat,
      this.data.lon,
      this.data.startTs,
      this.data.endTs,
      this.data.tz,
    );
    this.candidates.set(res?.candidates ?? []);
    this.confirmed.set(res?.confirmed ?? null);
    this.loading.set(false);
  }

  async choose(name: string): Promise<void> {
    this.saving.set(true);
    const ok = await this.health.confirmPlace(this.data.lat, this.data.lon, name);
    this.saving.set(false);
    this.dialogRef.close(ok ? name : null);
  }

  cancel(): void {
    this.dialogRef.close(null);
  }
}
