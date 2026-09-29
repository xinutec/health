/**
 * What the user met and nobody else saw — an uncaught error, a failed request —
 * into the activity trace, which already reaches the server's log: a phone has
 * no console anyone reads.
 */
import { ErrorHandler, inject, Injectable, Injector } from '@angular/core';

import { Telemetry } from './telemetry';

/** The message of anything thrown, unwrapping a rejected promise: `String()` of
 *  a plain object says nothing. */
export function messageOf(error: unknown): string {
  const inner =
    typeof error === 'object' && error !== null && 'rejection' in error ? error.rejection : error;
  if (inner instanceof Error) return inner.message;
  if (typeof inner === 'string') return inner;
  return 'non-Error thrown';
}

@Injectable()
export class TelemetryErrorHandler implements ErrorHandler {
  // Resolved on first use: the trace needs the Router, which cannot be built
  // before the ErrorHandler it would report to.
  private readonly injector = inject(Injector);

  handleError(error: unknown): void {
    console.error(error);
    try {
      this.injector.get(Telemetry).failure('error', messageOf(error));
    } catch {
      // Reporting must never throw from the one place that catches everything.
    }
  }
}
