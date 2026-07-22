#!/usr/bin/env nix-shell
#! nix-shell -i python3 -p python3
"""Bound `cosQ`'s non-monotonicity — the number `mkQCorridor`'s `cosSlack` rests on.

`Verified/Geo/Match.lean` takes a corridor-wide `cosQ` LOWER bound by evaluating
`cosQ` at the extreme |latitude| of the leg's band. That is only valid if `cosQ`
is non-increasing in |latitude|, and it is not: `cosQ` is a floor-rounded minimax
polynomial, and when its `-1453·x2` term steps down it drags `s1·x2` with it, so
the result can tick back up as |la| grows. `cosSlack` is subtracted to absorb
that. This measures what it has to absorb.

The reported figure is `max over a ≤ b of (cosQ(b) - cosQ(a))` — how far `cosQ`
can rise back above the running minimum, which is exactly the slack required.

Run: scripts/probe-cosq-monotonicity.py
"""

MAX_LA = 900_000_000  # |latitude| in 1e-7° units at the pole


def cos_q(la: int) -> int:
    """`Verified.Geo.cosQ`, in Python (`//` is floor division, as `Int.fdiv` is)."""
    x = abs(la) * 19190098069 // 10485760000000
    x2 = x * x // 1048576
    s1 = (-1453 * x2) // 1048576 + 43687
    s2 = (s1 * x2) // 1048576 - 524287
    return (s2 * x2) // 1048576 + 1048576


def max_rise(lo: int, hi: int, step: int) -> tuple[int, int | None]:
    """Largest rise above the running minimum over [lo, hi] scanning by `step`."""
    worst, where = 0, None
    run_min = cos_q(lo)
    for la in range(lo, hi + 1, step):
        c = cos_q(la)
        if c - run_min > worst:
            worst, where = c - run_min, la
        run_min = min(run_min, c)
    return worst, where


def main() -> None:
    cases = [
        ("whole range, 1e-4° resolution", 0, MAX_LA, 1000),
        ("London-width band, exhaustive", 514_000_000, 516_200_000, 1),
        ("equator, exhaustive", 0, 2_000_000, 1),
        ("near pole, exhaustive", 898_000_000, MAX_LA, 1),
    ]
    overall = 0
    for label, lo, hi, step in cases:
        rise, where = max_rise(lo, hi, step)
        overall = max(overall, rise)
        print(f"{label}: max rise above running min = {rise} (at la={where})")
    print()
    print(f"cosSlack must exceed {overall}; Match.lean uses 256.")
    print(f"cosQ(51.5°) = {cos_q(515_000_000)}, so 256 is "
          f"{256 / cos_q(515_000_000):.2e} relative — cells and the reject "
          f"loosen by that much, which is why the slack is free.")


if __name__ == "__main__":
    main()
