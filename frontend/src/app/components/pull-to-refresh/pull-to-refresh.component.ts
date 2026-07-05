import {
	afterNextRender,
	ChangeDetectionStrategy,
	Component,
	computed,
	ElementRef,
	effect,
	inject,
	input,
	type OnDestroy,
	output,
	signal,
} from "@angular/core";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import {
	isArmed,
	PTR_EXCLUDE_SELECTOR,
	PTR_MIN_SPIN_MS,
	PTR_REST_PX,
	pullDistance,
	pullProgress,
} from "./pull-to-refresh.logic";

/**
 * Pull-to-refresh wrapper. Wrap a scroll view in `<app-pull-to-refresh>`; when
 * the user drags down past the threshold while the page is scrolled to the top,
 * it emits `(refresh)` so the parent can reload its data (an `resource().reload()`),
 * NOT the whole page. Built for the custom WebView, where there is no native
 * browser pull-to-refresh; `overscroll-behavior` (set globally) lets it own the
 * gesture in plain browsers too.
 *
 * Bind `[busy]` to the reload's loading state so the spinner holds until the
 * data settles (with a short minimum so a cache-fast reload still registers).
 */
@Component({
	selector: "app-pull-to-refresh",
	standalone: true,
	imports: [MatProgressSpinnerModule],
	templateUrl: "./pull-to-refresh.component.html",
	styleUrl: "./pull-to-refresh.component.scss",
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PullToRefreshComponent implements OnDestroy {
	/** The reload's in-flight state — keeps the spinner up until data settles. */
	readonly busy = input(false);
	/** Suppress the gesture entirely (e.g. signed out / not yet loaded). */
	readonly disabled = input(false);
	/** Fired once per armed release: the parent should reload its data. */
	readonly refresh = output<void>();
	/** Mirrors the in-progress state so the parent can hide its own redundant
	 *  loading overlays while this component's spinner is showing. */
	readonly refreshingChange = output<boolean>();

	/** Current revealed pull distance in px (0 = closed). Drives the transform. */
	readonly pull = signal(0);
	/** True from an armed release until the reload settles. */
	private readonly refreshing = signal(false);
	/** Flips true `PTR_MIN_SPIN_MS` after a trigger — the minimum-spin floor. */
	private readonly minElapsed = signal(true);

	readonly armed = computed(() => isArmed(this.pull()));
	readonly progress = computed(() => pullProgress(this.pull()));
	readonly spinning = computed(() => this.refreshing() || this.busy());
	/** Indicator y-offset: rides down out of its hidden slot as you pull. */
	readonly indicatorY = computed(() => this.pull() - 36);

	private active = false;
	private startY = 0;
	private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

	constructor() {
		afterNextRender(() => {
			const el = this.host.nativeElement;
			el.addEventListener("touchstart", this.onStart, { passive: true });
			// Non-passive so we can preventDefault and own the overscroll.
			el.addEventListener("touchmove", this.onMove, { passive: false });
			el.addEventListener("touchend", this.onEnd, { passive: true });
			el.addEventListener("touchcancel", this.onEnd, { passive: true });
		});

		// Snap shut once the reload has settled AND the spinner has shown for at
		// least the minimum time (so an instant cache reload doesn't flicker).
		effect(() => {
			if (this.refreshing() && !this.busy() && this.minElapsed()) {
				this.refreshing.set(false);
				this.pull.set(0);
			}
		});

		// Mirror the in-progress state out so the parent can suppress its own
		// loading overlays while this spinner owns the feedback.
		effect(() => this.refreshingChange.emit(this.refreshing()));
	}

	ngOnDestroy(): void {
		const el = this.host.nativeElement;
		el.removeEventListener("touchstart", this.onStart);
		el.removeEventListener("touchmove", this.onMove);
		el.removeEventListener("touchend", this.onEnd);
		el.removeEventListener("touchcancel", this.onEnd);
	}

	private readonly onStart = (e: TouchEvent): void => {
		// Only arm at the very top of the page, with a single finger, when idle.
		if (this.disabled() || this.refreshing() || e.touches.length !== 1 || window.scrollY > 0) {
			this.active = false;
			return;
		}
		// Don't steal the gesture from an element that handles its own drag —
		// the Leaflet map (pan) or anything that opts out with the attribute.
		// A downward drag there is panning, not a pull-to-refresh.
		const target = e.target as Element | null;
		if (target?.closest(PTR_EXCLUDE_SELECTOR)) {
			this.active = false;
			return;
		}
		this.active = true;
		this.startY = e.touches[0].clientY;
	};

	private readonly onMove = (e: TouchEvent): void => {
		if (!this.active) return;
		const dy = e.touches[0].clientY - this.startY;
		if (dy <= 0) {
			// Finger reversed before pulling — release the gesture so a normal
			// upward scroll isn't swallowed.
			this.active = false;
			this.pull.set(0);
			return;
		}
		e.preventDefault();
		this.pull.set(pullDistance(dy));
	};

	private readonly onEnd = (): void => {
		if (!this.active) return;
		this.active = false;
		if (isArmed(this.pull())) {
			this.refreshing.set(true);
			this.minElapsed.set(false);
			this.pull.set(PTR_REST_PX);
			this.refresh.emit();
			setTimeout(() => this.minElapsed.set(true), PTR_MIN_SPIN_MS);
		} else {
			this.pull.set(0);
		}
	};
}
