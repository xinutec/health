import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { MatBottomSheetRef } from "@angular/material/bottom-sheet";
import { MatButtonModule } from "@angular/material/button";

/** What the awake-at-rest chart measures, opened from the "?" beside its title.
 *  Mirrors the rules in `Verified.RestHr`; change both together. */
@Component({
  selector: "app-rest-hr-help",
  standalone: true,
  imports: [MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./rest-hr-help.component.html",
  styleUrl: "./rest-hr-help.component.scss",
})
export class RestHrHelpComponent {
  readonly ref = inject(MatBottomSheetRef<RestHrHelpComponent>);
}
