#!/usr/bin/env nix-shell
#! nix-shell -i python3 -p python3
"""Evidence that `cosQ` is NOT non-increasing in |latitude|.

This is why `Verified/Geo/Metric.lean` derives its corridor cosine floor from
`cosQLowerBound` — which bounds `s2` by a constant and needs no property of
`cosQ` at all — rather than the tempting route of evaluating `cosQ` at the band's
extreme |latitude| and calling it the minimum. That route is unsound: `cosQ` is a
floor-rounded minimax polynomial, and when its `-1453·x2` term steps down it
drags `s1·x2` with it, so the result ticks back UP as |la| grows.

The script exists to keep that claim checkable instead of asserted. It reports
`max over a ≤ b of (cosQ(b) - cosQ(a))` — how far `cosQ` climbs back above its
running minimum. Anything above 0 refutes monotonicity.

It no longer sizes any constant in the Lean source. An earlier version of
`mkQCorridor` subtracted a sampled `cosSlack = 256` derived from these numbers;
that was replaced by a proved bound (`cosQLowerBound_le`), because a measured
worst case over a sampled range is not a proof over all of them.

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


def cos_mul_sq(la: int = 515_000_000) -> int:
    """`cosMul(la)^2 >> 20` — the `t` that `cosQLowerBound` is a function of."""
    x = abs(la) * 19190098069 // 10485760000000
    return x * x // 1048576


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
    print(f"max rise anywhere = {overall} — any value > 0 means `cosQ` is not "
          "non-increasing in |latitude|, so evaluating it at a band extreme "
          "does NOT give a lower bound over the band.")
    print(f"cosQ(51.5°) = {cos_q(515_000_000)}; the proved floor "
          f"`cosQLowerBound` returns {1048576 - (524287 * (cos_mul_sq()) + 1048575) // 1048576} "
          "there, i.e. it gives up a few percent in exchange for being provable.")


if __name__ == "__main__":
    main()
