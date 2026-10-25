---
created: 2026-10-10
status: SHIPPED at the flip (2026-10-22) — the decoder heads the served fold on every decoded day, with the journey state on the shipped record (`CLASSIFIER_VERSION` 11)
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
`segEmission.journey` key, and served since the flip of 2026-10-22: the
decoder's segments head the fold on every day with a stored decode, Lean runs
the naming tail over them, and a day without one (today; a day the re-decode
has not reached) is still the cascade's (`fold_payload.rs`,
`DayEntry.decoderHead`). The history of how it got here is in git and the
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
  params, `durationFits.unknown`); the wait's duration is the fitter's own
  (nine narrated platform waits on the 2026-10-20 narratives, floor two
  minutes). The shipped record is golden `fits/decoder-params.json`: the
  in-sample fit with those additions laid over it, the Secret's one line.
  Decode time +50% a day.
- **The gate folds what production folds.** A day fixture's own `hsmmDecode`
  is a replaced decoder's row; the corpus gate folds each day on its frozen
  decode twin's blessed rows (`decode_fixture::stored_decode`, the row
  `decoded_days` holds after the re-decode) and refuses a day without a twin.
  `FOLD_DECODER_HEAD=<dump>` puts an arm's decode in the stored one's place.

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

The flip itself (2026-10-22), on the in-sample record refitted on the
2026-10-20 narratives, frozen scoreboard and the same instrument: with the
journey state 129/315/61/65/4 and 21 lost / 28 gained; the same record without
it 129/313/63/69/4 (the old record's counts to the number) and 18 / 22. The
journey state ships. Against the served day's floors: 18 truth rows cut and 22
newly held (527 → 531), three journeys cut (05-25 11:30Z, 07-07 15:48Z,
10-07 10:39Z) and six gained (131 → 134); the impossible legs on 06-18 and the
teleport on 10-02 gone, a kinematic leg each on 07-02 and 08-10 under the
sharded gate (ceilings set by hand). The days losing a whole leg kind stay
07-06 (the hop) and 06-09 (the bus).

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

## The calling evidence (S2's stops)

A train leg is scored at each station it passes wholly inside it, for its own
line where that line calls there: the ratio of a calling train's to a through
train's density of the pass's speed (`Verified.Hsmm.StopCalls`, the passes in
`StationStops`, the leg cell's `Journey.stopTerm`). A line that does not call
there scores nothing. A minute's position is its fixes' median, a kilometre
apart at speed, so a station is passed where it lies within the chain's
station radius of the path between two consecutive minutes; the observation is
the slowest minute within reach of it, else the path's speed. A pass touching
the leg's first or last minute is its board wait or its arrival, and the leg's
own board and alight stations are left out by name.

The fit (`fit_emissions`, form `fitStops`): the narrated rides' passes, read
off the decoder's own output (`emissionDebug.stationPasses`), as one
stopped-or-moving mixture with a calling and a through share by EM, each share
by the rule of succession (EM alone puts the calling share at 1). Its record
key is `segEmission.journey.stops`; the numbers are in the golden record.

Measured on the shipped record with and without the key (2026-10-24):
scoreboard lines 61 → 64, stations 62 → 66, journeys, leg modes and phantoms
unchanged; held out on fresh records with and without it, the same direction;
narrated rows nothing lost, 06-23's ride and the four Finchley Road change rows
of 06-15 and 09-14 held. On the 200 history days every leg that moves on the
Wembley Park–Finchley Road stretch agrees with the stops judge
(`instruments/metjub.py`). Decode cost +3%.

Open, from the history sweep: 06-12's change is drawn by the form that scored
every pass touching a leg and lost by this one (the generator's entry prior
holds the single Jubilee ride: +3 for its line, −8 for any other, hand-set, and
the generator vouches whole station-to-station rides, so never a ride that ends
in a change); the Euston Square–King's Cross hop ties a Victoria hop from Euston
on three days within half a nat, a leg too short to have an inside;
09-10's evening ride ends at Great Portland Street, not Baker Street; 08-28's
wait at Willesden Green's bus stop is drawn as a walk.

The train generator's entry prior (+3 for a vouched line on a covered minute,
−8 for any other), measured 2026-10-25 against the shipped record, in-sample
and held out alike — REFUTED in both forms, so it stays: removed, journeys
−1, leg modes −3, lines −3, stations −7, rows 3 lost / 1 gained, a kinematic
leg on 05-18, and 06-15 and 09-14's Finchley Road changes undone (it carries
the whole station-to-station ride); fitted as two log-likelihood ratios at
the narrated rides' first covered minute (true line vouched 0.971 of 68,
another 0.095 of 680: +2.32 / −3.46), lines −1, stations −2, rows 1 / 1,
09-14 lost. The narrated ride starts are not the entry term's cases — it
decides at every leg start the decoder weighs, waits and changes among them —
so a fit needs the decoder's own candidate starts.

## Open

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

- The cascade — CUT 2026-10-25, with `absorbIntraPlaceWalk`'s twelve minutes and
  `consolidateJitterStays`' 75 m among its 36 passes: every served day folds from
  its stored decode (decoded on read by the decode worker, a day never decoded
  answers that it is being decoded), so the split, enrichment and pre-fold
  stages and every pass outside the naming tail went, with the modules only
  they used.
- With S1 and S2 on the shipped record: `boardAtWait` and `boardingStayLabel`'s
  fold — CUT 2026-10-22, neither ran under the head and the 200-day sweep read
  the same (`histfold-headed.sh`, headed against headed on one decode dump);
  `interchangeStayLabel` — CUT 2026-10-23, into its mirror: `alightStayLabel`
  names the first stay after a ride, across walks, for the station the ride's
  own label alighted at when the stay is in range of it, and only where the
  picker's name came by rank alone or there was none
  (`TransitPlace.stationsAfterAlighting`; the measured basis is in its doc).
  The old pass's adjacency and bracketing rules and its dwell bound went:
  under the head a walk up from the platform parts nearly every ride from the
  stay after it (05-22's nineteen minutes at Finchley Road, named for the shop
  beside it, now the station: truth 531 → 532; 06-15's bus-stop wait at Green
  Park, "Pret A Manger" before, named for the station and still outside his
  row's wording). Measured on the 200 days against run_flip0: 9 days move a
  stay's name. Without the source rule 16 did, four of them against his rows
  (a Pret 69 m from Euston's node, a coffee 145 m from Wembley Park's, John
  Lewis above Canary Wharf, a 143-minute dinner 96 m from Liverpool Street:
  every wrong rename replaced a `nearField` name, every right one a `ranked`
  name or none; 15–46 m from a node of the station against 69–145 m). The
  dinner is named by rank and is still renamed: the alight side has no fitted
  duration, which the decoder's own wait state would bring. The boarding
  labeller runs first, so a change of trains keeps the name of the train it
  waits for (10-08's Hendaye). An alight-side wait STATE waits on a
  population: the narrated stays at the alight station are seven changes
  before another ride, which S1 covers, and one terminal wait (05-22). The
  chain's post-hoc line pick where the leg names
  its station — NOT YET (measured 2026-10-22, the S2 leg's own line kept where
  it named its board station): the frozen scoreboard is unmoved on the 43
  narrated days, and 9 of the 200 history days move 10 legs, every one a
  Wembley Park ↔ Finchley Road / Baker Street ride swapping Metropolitan and
  Jubilee on their shared track, both ways. JUDGED 2026-10-24, and the cut is
  refuted: between Wembley Park and Finchley Road the Jubilee calls at five
  surface stations the Metropolitan runs through, and the narrated rides
  separate on that alone (`fits/instruments/metjub.py`: both Jubilee rides
  dwell about half a minute at four or five of them, none of the six Met rides
  at any, 06-23's nineteen-minute Met included). Every one of the eight legs
  whose served line moves is a Met ride by that test (no dwell, 60–100 km/h
  through each platform): the chain's pick is right on six, the leg's own line
  on two (07-29, 08-24). Neither picker read the stops; the decoder's legs do
  since the calling evidence (below, "The calling evidence"), and the pick is
  to be re-measured against them. The train generator's entry prior (+3, −8,
  hand-set) is the next to measure out: it vouches whole rides, and held
  06-12's change on one.
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
signal; `truthcut.py` and `journeyfloor.py` apply a gate log's cuts and gains
to the two floors by hand.
