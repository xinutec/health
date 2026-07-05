# Privacy in tests, commit messages, and docs

This repo holds a single-user health-tracking system. Real data —
GPS, biometrics, journey patterns — necessarily flows through the
code. Decisions about where that data is allowed to live matter
because some surfaces (git, GitHub, public mirrors) cannot be
ungossiped.

## Rule

> Real personal data — specific locations, dates of real trips,
> biometric values, the user's actual journey patterns — must not
> appear in:
>
> - Commit messages
> - Test docstrings or comments
> - Code comments
> - Markdown docs that go into git
>
> Files that **do** go into git (source, tests, docs) describe
> classes of behaviour and use synthetic data. Files that hold real
> data (`tests/fixtures/days/*.json` captured by `capture-day.ts`)
> are gitignored and stay local.

## Why this exists

Git history is durable. Even a force-push doesn't remove commits
from existing clones, GitHub's archive view, or third-party search
indices. A commit message saying "the user's 2026-05-12 morning
commute from Wembley Park to Kings Cross" is a permanent statement
of where this person lives and works.

Aggregate inferences from such commits — readable by anyone with
clone access — are exactly the privacy concern the user named in
their personal feedback memory:

> keep personal location, biometric data, family/social context out
> of commit messages, code comments, and test fixtures.

## What's allowed

- **Public landmark coordinates** as test inputs. (51.5635, -0.2795)
  is the published coordinate of Wembley Park station; using it
  as a constant in test data doesn't reveal anything about any
  specific person.
- **Station and road names as test data** when they're widely-used
  public landmarks AND the test does not tie them to "the user's"
  routine. `stationA = "Kings Cross"; stationB = "Wembley Park";`
  in a test for "two-stop train journey labelling" is fine. Same
  names in a test described as "the user's daily commute" is not.
- **Abstract failure descriptions** in commit messages and test
  comments: "decelerating train through a non-disembark station,"
  "footway 20m from arterial road at urban-driving speed."

## What's not allowed

- **Real dates** tied to specific trips in commit messages or test
  comments: "2026-05-12 morning trip", "today's 17:48 ride".
- **Real journeys**: "the user's Wembley → Kings Cross commute",
  "80+ mornings of this pattern".
- **Real lat/lon precise to 4+ decimals** in commit messages
  describing where "the user" was: `(51.524, -0.144)` is fine as
  a test input; "the user was at (51.524, -0.144) at 17:44" is not.
- **Real biometric values** in test comments: "the user's HR was
  62 bpm during the train ride" — even though 62 bpm is unremarkable
  in isolation, it builds a profile when aggregated across commits.

## Practical guidance

When writing a test or commit message about a real-data-derived
bug, anonymise the description first. Instead of:

> Real case from 2026-05-12: GPS fix on the 13:29 drive landed on
> the pavement next to Great Central Way. The mirror returned the
> footway at 21m AND Great Central Way (secondary) at 27m...

Write:

> Urban driving fix lands ~20 m from a footway and ~30 m from a
> parallel arterial road. Both within the 50 m nearbyWays radius.
> The labeller must prefer the driveable road at driving speeds.

The bug description is unchanged; the user's specific journey isn't
exposed. Coordinates in the test data stay the same — they're
public station/road locations and they're decoupled from any
narrative about "the user."

## Fixtures

- **`tests/fixtures/days/*.json`** — gitignored. Captured by
  `capture-day.ts` from real data. Used locally for calibration and
  for hand-editing `groundTruth`. Never goes into git.
- **`tests/fixtures/synthetic/*.json`** (when this directory exists)
  — in git. Hand-authored with synthetic place names ("Town A
  Station", "Mainline B"), synthetic coordinates (e.g. fixed offsets
  from (0, 0)), and synthetic biometrics. Used by the CI snapshot
  test.
- Inline test fixtures inside `*.test.ts` files — fine with public
  landmark coords as test data, but the surrounding test comments
  must describe an abstract scenario, not the user's actual journey.

## Retrospective on commits before this doc landed

A number of commits already in git history (specifically `d3d0223`,
`3c96301`, `7c30055`, `5d60072`, and parts of `d07b1f5` and others
in the 2026-05-13 session) contain commit messages that violate the
rule above. These were pushed to GitHub before the rule was
codified. Rewriting public git history is more disruptive than the
leak warrants, so the existing commits are left as-is and this doc
exists so the rule is durable going forward.
