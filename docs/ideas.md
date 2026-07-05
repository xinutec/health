# Ideas — future considerations

Small heuristic refinements and UX tweaks that aren't substantial
enough for a full `proposals/` doc but worth remembering. Promote
to a proposal if the scope grows; delete entries that ship.

Each entry should be short: the trigger that prompted the idea,
the proposed rule, and whatever is keeping us from landing it now.
"Keeping us from landing it now" is usually one of:

- Not enough data to validate the rule (we haven't seen the
  failure case the rule would prevent, or the case is so rare we
  can't tune it).
- Cost outweighs benefit at our scale.
- Depends on a different piece of work that hasn't shipped.

## Active ideas

### Fold short walking segments inside a long stationary period

**Trigger.** A 5-minute "walking" segment surfaces in the middle of
several hours of `stationary @ Work`. The classifier is correct
about there being a walking event (Fitbit step counter, GPS
displacement, and OSM footway resolution all agree), but the
narrative value in the "your day" view is low: most people don't
care about coffee-run-and-back micro-loops.

**Proposed rule.** Fold a `walking` DayState into the surrounding
`stationary` DayStates iff *all* of:

- Duration < 10 minutes.
- Surrounded on both sides by `stationary` DayStates at the same
  place.
- Net displacement (start fix to end fix) < ~50m — i.e. the walk
  returns to where it started.
- No OSM annotation (no `[on footway]`, no `wayName`) — indoor
  loops shouldn't snap to a named outdoor way.
- Optionally: small heart-rate delta (no `+20` BPM bump) — purely
  indoor pacing doesn't raise HR much.

The rule must NOT fold a brief outdoor walk that just happens to
loop back. The OSM-footway and HR signals are what keep the rule
honest.

**Why we're not landing it now.** Every walking event we've
captured to validate against has at least one of the outdoor
signals (footway match, HR rise, or > 50m displacement). Without a
real "I walked to the printer and back" fixture, we'd be tuning
the rule against a hypothetical and risking false folds that hide
genuine short walks. Revisit when we have a captured day with a
verified indoor-pacing episode.

**Where it would land.** Post-processing pass in
`src/sleep/day-state.ts` (the same module that already merges
adjacent same-state runs). New helper `foldIndoorPacing` runs
after `mergeAdjacent`.
