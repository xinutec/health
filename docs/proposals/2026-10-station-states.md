---
created: 2026-10-10
status: built behind the journey state's record key; measured; the flip is the next decision
references:
  - decoder-roadmap.md
  - 2026-10-shared-levels.md
  - 2026-07-continuity-c4.md
  - ../design/probabilistic-principles.md
---

# Stations as decoder states

The decoder roadmap's step 2: the platform wait, the board station and the
line are one state, not three fixes. Built inside the journey state
(`2026-10-shared-levels.md`, "The journey state"), behind the record's
`segEmission.journey` key. The history of how it got here is in git and the
task; this file is the design as built, the rule it is judged by, the numbers,
and what is open.

## The design as built

Inside a journey (an outer `.unknown` state whose cell is an inner sweep over
legs sharing the base states' emissions, `Verified/Hsmm/Journey.lean`):

- **S2, a ride that knows where it boarded.** A `train L@σ` leg per named line
  L and station σ within reach of the day's fixes (400 m, a fix no staler than
  six minutes). It begins only at a minute σ is within reach; its duration is
  priced against the pair's ride time instead of the train's duration prior —
  the along-line path from σ's footprint to the alight's, the served calls
  between, the chain's ride-time form. The alight is another station by name
  on the line, the one nearest the first fix that lies beyond σ's reach within
  the stale window (a track that sits where he boarded is the phone repeating
  itself underground). A station is on a line when the line's track reaches
  its 200 m footprint (`stationOnLine`): King's Cross's six nodes carry
  Victoria, Piccadilly and untagged edges, and the Met's track runs through
  its footprint.
- **S1, the platform wait.** A wait leg per station within reach, on a
  stationary base (`WAIT_MARK`), its duration `durationFits.wait`: fitted by
  `fit_emissions` on the narrated waits before a ride (a stationary row with no
  place after a walk and before a train or bus — three, of 4, 5 and 14 minutes)
  with the shortest as its floor, the fit's third number. The pair rule: a wait
  at σ is followed by a ride boarding at σ and by nothing else, and never ends
  a journey. A decoded wait leaves the assembler with its station
  (`boardStation`) and the fold serves it as a stay at that station.
- **Under the decoder head the tail names and does not re-draw.** The head's
  tail (`DECODER_TAIL`) has no `finalMerge`, and `boardingStayLabels` names the
  waits after their station without folding the walk between two of them.
- **The record.** The journey state's additions beside a fitter record are in
  golden `fits/journey-record-2026-10-19.json` (the `unknown` level, the journey
  params, `durationFits.unknown`); the wait's duration is the fitter's own.
  Decode time +50% a day.

## The journey rule (the referee, both sides)

A journey is bounded by a stay the day walks or drives away from, by a sleep,
or by unaudited time the day walks away from; a stay — or unaudited time — the
day boards a ride from is the wait for it, a pause however long and whatever it
is called; unaudited time straight after a ride is the platform it alights
onto. The only number is the rows' own minute, inside which a gap is rounding.
No place name is read. The same rule in `Journeys.lean` (the narrative side),
`DecoderScore.lean` (the decoder side) and `JourneyShape.lean` (the drawn
timeline). His direction, 2026-10-20: a stay before a train is the journey's
however long it is; a hard-coded five minutes is a rigid number to remove.

Two forms refuted the same day, both measured on the frozen scoreboard and the
served floors: a placed stay bounds and a placeless one pauses (the decoder
leaves visits unnamed where the narrator names them — 04-29, 06-15, 10-08 lost
every match — and Baker Street's one-minute change is placed); a stay pauses if
a ride follows before the next stay (a visit, the walk to the station and the
train is how most trips begin; 05-15 3 → 1 journeys expected). The rule's blind
spot, one key: a wait on Victoria's forecourt, the walk down to the platform,
the train (06-12), which no rule without geometry tells from Home.

Of the corpus's fifteen placed stays written directly before a ride, fourteen
are stations. The two visits that had their walk to the train folded in
(10-08's café, 07-16's hospital) were re-windowed from the signal; his words on
07-16 stand verbatim beside it.

## Measured

All on one set of fresh fitter records (`fit_wf`, held out), the referee above,
the narratives of 2026-10-20. Scoreboard = journeys/legMode/lines/stations/
phantoms over 43 days; rows = narrated rows the head loses / gains against the
served day (`flipcheck.sh`).

| arm | scoreboard | rows lost / gained |
|---|---|---|
| base decoder at the head of the fold | 129/313/63/69/5 | 18 / 21 |
| journey state: S2 legs, S1 wait, the tail above | 129/316/62/67/6 | 22 / 27 |

Journey state against the base head: +6 gained (05-18's hop, the platform
waits 06-15, 06-17, 06-18, 09-15, 07-02's and 10-08's walks, 07-16's re-timed
walk), −2 gains (05-22 19:38Z, 06-23 07:42Z), +4 lost (05-22's Finchley Road
wait, 06-16's cadence minute, 07-02's fused ride, 07-06's hop walked through);
three leg modes ahead, a line and two stations behind, a phantom more.

Steps on the way, each measured on the rows (the scoreboard cannot see a
boundary or a label):

| step | effect |
|---|---|
| S2's board-station legs (the 2026-10-19 slice) | the three Baker Street hops decode; lines and stations down: the Victoria's Euston ties the Met's Euston Square at the same fixes, a two-nat tie the pair term decides |
| S1's wait leg, pair rule, fitter's duration | both narrated waits found; a mid-walk pause decoded as walk + wait until the wait could only be followed by its ride |
| the footprint station test | the Baker Street splits heal (06-29, 07-06, 07-07); five real platform waits appear that the narratives folded into walks (zero steps, resting heart rate, then the first fast minute) — now rows |
| the alight by station, not node | phantoms 11 → 7: a Met ride from King's Cross to another of its own nodes expected 0.8 minutes |
| the decoded wait served at its station | Work no longer swallows the walk to the station (09-15); 07-07's wait at Warren Street shown as the decoder's, no longer named after the hospital |
| the tail names, does not re-draw | 10-08's walk to the platform at Hendaye and 07-16's morning back: the base head net positive |

## Refuted — do not rebuild without a new form

- **A platform state beside the others (2026-10-10, three arms):** 114/279/52/
  48/7, 113/280/54/50/8, 115/274/52/46/7 against 117/280/53/45/6. Without its
  own entry rate and wait length it displaces the stay beside the station;
  what it bought was stations (+5 with the wait folded), evidence for the
  anchor side, not for the state.
- **#366's `train|head`** (twice, 2026-09-29/30): the head could become any
  line at one price and the cheapest won — the line must be decided where the
  head is, by the platform's lines.
- **S2's end anchors** (the chain's position density on a leg's last minute):
  118/311/57/55/5, rows 48/20; relative to the best station of any line
  120/311/57/58/6, 46/20. Ride-end fixes are where he walked to, not where he
  alighted.
- **Legs without an entry prior** lose lines; **the covered-train floor
  relaxed inside legs** gives twenty one-minute phantoms; **a prefix sum over
  −∞ emissions** poisons every later minute (floor each minute).
- **The two-minute hop by term** (07-02, `path_debug`): walk + hop + walk
  against one walk loses 12 nats — the pair across each new boundary −15.5,
  the short segments' displacement −8.6, duration priors −6.6, the extra
  segments' heart-rate and fix-share levels −5.6, transitions −3.7 against the
  hop's own +25. The boundary span per mode pair (arm-boundaryclass) is
  neutral; the ride duration is near-exponential (shape 1.09) so a short ride
  is already cheap. The structure that names it is the pair's ride time (S2).
- **The two referee forms above.**

## Open

- **The flip** — his call by his 2026-10-19 rule (several rows; no day losing a
  whole leg kind): the margin is there; the days that lose a leg kind under
  either arm are 07-06 (the one-stop hop walked through) and 06-09 (the bus,
  which no arm has). Finished days only, `CLASSIFIER_VERSION` bump, deploy,
  history re-decode.
- **S2's remaining losses:** 06-16 is the train-cadence class (116 steps at
  11:05Z inside a train at 37 km/h cost the narrated Met leg 69 nats; refuted
  twice, `2026-10-segment-emissions.md`); 07-02's one ride without a station
  prices under the split (18 minutes on the base duration −67 against the
  Jubilee pair's −60 and the Met pair after it); 07-14's hop takes a three-
  minute wait and rides Victoria (the tie).
- **A pause's own duration:** a two-minute placed stop the decoder draws inside
  a walk (10-07) is a stay the day walks away from; the narrated stops between
  walks (5, 7, 7, 8, 16, 18 minutes) are the population for its fit.
- **The decoded wait where no wait is decoded** (07-01's four minutes sit on the
  floor): the stay's end under the decoder is #1947's next slice.
- **S3, confidence as a posterior:** forward–backward over the trellis; a
  station or line emitted when its posterior clears a level read off the
  narrated days, not by `MARGIN_NATS`. Not started.

## What retires

- At the flip: the fold's stay-absorbing and window-stretching passes under the
  head are already out of its tail (`finalMerge`); `absorbIntraPlaceWalk`'s
  twelve minutes and `consolidateJitterStays`' 75 m go with the served cascade
  when the history re-decode reads the same without them.
- With S1 and S2 on the shipped record: `boardAtWait`, `boardingStayLabel`'s
  fold, `interchangeStayLabel`, and the chain's post-hoc line pick where the leg
  names its station — each cut when the 200-day sweep reads the same without it.
- After S3: the station chain's anchor, transfer and margin constants
  (`StationChain.lean`, "Scoring terms").
- Not by this: buses (no bus state).

## Instruments

`journeyDebug: {alt: [{startTs, endTs, leg}]}` on an `assemblesegments`
request (`dump_decode_request <date>-<user>` with `DECODER_PARAMS` set, then
`verified_cli serve`): a decoded journey's legs with cell, emission, entry,
transition and expected ride time, against a forced alternative; legs are named
`train|Metropolitan Line@Euston Square`, `stationary|none|wait@Euston`.
`arms8.sh <tag>` for the held-out scoreboard, `flipcheck.sh <tag> <dump>` for
the rows (one corpus gate at a time: the flip check rewrites and restores the
name-confidence ledger), `rowaudit.py` for a lost row beside the head and the
signal.
