import { DOCUMENT, Injectable, inject } from "@angular/core";
import { NavigationEnd, Router } from "@angular/router";
import { TelemetryCore } from "@xinutec/ui-harness/telemetry";
import { filter } from "rxjs";

/**
 * The Angular binding for the fleet's activity trace.
 *
 * The queue, the flush policy, the transport and the label rules are shared —
 * `@xinutec/ui-harness/telemetry`, tested once there. What has to stay here is
 * the framework binding: an `@Injectable` cannot be shipped from that package,
 * because it is built by plain `tsc` and Angular's decorators need the Angular
 * compiler to emit their Ivy definitions. A decorated class crossing that
 * boundary carries only inert metadata, and a production build fails on `JIT
 * compiler unavailable` — which is exactly how this was found.
 *
 * So the split is: the two capture seams and the DI wiring here, everything
 * else there. Instrumented once, from the app shell, so no screen knows the
 * trace exists and no new control can be missed by forgetting to annotate it.
 */
@Injectable({ providedIn: "root" })
export class Telemetry {
  private readonly router = inject(Router);
  private readonly doc = inject(DOCUMENT);
  private readonly core = new TelemetryCore(this.doc);

  /** Wire the two capture points. Called once from the app shell; idempotent. */
  init(): void {
    if (this.core.started) return;

    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.core.record("nav", e.urlAfterRedirects, null));

    // Capture phase, so the tap is seen even where a handler stops propagation.
    this.doc.addEventListener("click", (ev) => this.core.recordTap(ev.target, this.router.url), {
      capture: true,
    });

    this.core.start();
  }
}
