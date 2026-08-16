import Verified

/-!
# `OsmHost` — the three matcher lookups, answered by the process we run inside

`PassFold.Env`'s `walkEnv`/`roadEnv` are declared shells, and `DayEntry`'s
`UNFED` says why: their "street-network reads and search leaves are 4.31 MiB/day
the wire measurement deliberately left shell-side".

Stated precisely, because the loose version of this was wrong once. `OsmTrace`
DOES carry `walkableRoads`, `buildingsNear` and `drivableRoads` sections — they
exist for fixture capture — so it is not that the request could not hold them.
What is true is narrower: `day-serve.ts`'s round loop does not answer them, and
`UNFED` gives the reason as the wire cost of doing so, 4.31 MiB/day across the
2-7 rounds the loop takes. That cost is an ASSERTION in a comment; nobody has
measured it, because the shells answered empty before the ask could be recorded.

Answering by CALLING sidesteps it either way, and — see the counters in
`rust/day-shell/src/osm.rs` — finally makes the ask countable. Lean declares
these `@[extern]`; whoever links the fold provides them:

  `verified_cli`      `osm-host-stub.c` — empty results, so the spawned CLI
                      keeps exactly the shell behaviour it has today.
  `rust/day-shell`    the real reads, in the host process, with no wire.

That asymmetry is the point rather than a compromise: a spawned pure function
CANNOT answer a query it generates mid-run, and a host sharing the process can.

# Why a `ByteArray` and not the real types

Building `Array (Array Pt)` from C means constructing Lean objects by hand, and
a mistake there is a memory bug rather than a wrong answer. The externs return
one flat buffer instead — a single `lean_alloc_sarray` on the C side — and the
decoding is done HERE, in Lean, where it is ordinary total code with `#guard`s
on it.

Wire format, little-endian throughout:

    u32          number of polylines
    per polyline:
      u32        number of points
      per point: f64 lat, f64 lon

`Ways` and `Array Ring` are both `Array (Array Pt)`, so one decoder serves
`walkableRoads` and `buildingsNear` both. `drivableRoads` returns `Array Way`,
which carries `osmId`/`name`/`subtype` as well, so it gets a SECOND format
rather than being smuggled through this one:

    u32          number of ways
    per way:
      u64        osmId, two's complement
      u32        name length, or `0xFFFFFFFF` for absent, then that many
                 UTF-8 bytes
      u32        subtype length, same convention
      u32        number of points
      per point: f64 lat, f64 lon

The absent marker is distinct from a length of zero on purpose. `Way.name` is an
`Option String` and the road matcher's way-switch penalty reads it; an unnamed
way and a way named `""` are different things to a turn prior, and collapsing
them would be a silent routing change.

# Deliberately not in `Verified`

That library has no `Json`, no `IO` and no `@[extern]`, and its folds are pure so
their `#guard` specs mean something. A callback into a host is the opposite of
that. `DayEntry` is already the impure layer — it is where the parser lives — so
the boundary goes here.
-/

namespace DayEntry.OsmHost

open Verified.Geo.WalkableRoute (Pt)
open Verified.Geo.OsmCorridor (Way)

/-- `Ways` and `Array Ring` are the same shape; see the header. -/
abbrev Polylines := Array (Array Pt)

/-! ## Reading the buffer

Total by construction: every read is bounds-checked against the buffer and
answers `0` past the end rather than panicking. A truncated buffer therefore
decodes to a SHORTER result and never to a crash — the right failure for a host
that died mid-answer, and why these take a `ByteArray` rather than trusting a
length the producer also wrote. -/

/-- One little-endian `UInt32` at `i`, or `0` if it does not fit. -/
def u32At (b : ByteArray) (i : Nat) : UInt32 :=
  if i + 4 > b.size then 0
  else
    (b.get! i).toUInt32
      ||| ((b.get! (i + 1)).toUInt32 <<< 8)
      ||| ((b.get! (i + 2)).toUInt32 <<< 16)
      ||| ((b.get! (i + 3)).toUInt32 <<< 24)

/-- One little-endian IEEE-754 double at `i`, or `0.0` if it does not fit.
Assembled from its bit pattern, the convention `Wire.jBits` already uses across
the JSON boundary — a double crosses as its bits and is exact, with no decimal
round trip to lose `1e-7` or `-0.0`. -/
def f64At (b : ByteArray) (i : Nat) : Float :=
  if i + 8 > b.size then 0.0
  else
    let byte (k : Nat) : UInt64 := (b.get! (i + k)).toUInt64
    Float.ofBits <|
      byte 0 ||| (byte 1 <<< 8) ||| (byte 2 <<< 16) ||| (byte 3 <<< 24)
        ||| (byte 4 <<< 32) ||| (byte 5 <<< 40) ||| (byte 6 <<< 48) ||| (byte 7 <<< 56)

/-- Decode `n` points starting at `off`. -/
private def points (b : ByteArray) (off n : Nat) : Array Pt :=
  (Array.range n).map fun k =>
    { lat := f64At b (off + k * 16), lon := f64At b (off + k * 16 + 8) }

/-- `fuel` bounds the polyline loop so this is structurally total. -/
private def go (b : ByteArray) (fuel off : Nat) (acc : Polylines) : Polylines :=
  match fuel with
  | 0 => acc
  | fuel + 1 =>
    if off + 4 > b.size then acc
    else
      let n := (u32At b off).toNat
      go b fuel (off + 4 + n * 16) (acc.push (points b (off + 4) n))

/-- Decode a whole buffer written in the header's format. -/
def decodePolylines (b : ByteArray) : Polylines :=
  -- A polyline costs at least 4 bytes, so the buffer itself caps how many there
  -- can be: a corrupt or hostile count cannot make this loop long.
  go b (min (u32At b 0).toNat (b.size / 4 + 1)) 4 #[]

/-! ## Reading a way

The second format, for `drivableRoads`. Same totality contract: every read is
bounds-checked, a truncated buffer decodes to fewer ways, and nothing panics. -/

/-- One little-endian `UInt64` at `i`, or `0` if it does not fit. -/
def u64At (b : ByteArray) (i : Nat) : UInt64 :=
  if i + 8 > b.size then 0
  else
    let byte (k : Nat) : UInt64 := (b.get! (i + k)).toUInt64
    byte 0 ||| (byte 1 <<< 8) ||| (byte 2 <<< 16) ||| (byte 3 <<< 24)
      ||| (byte 4 <<< 32) ||| (byte 5 <<< 40) ||| (byte 6 <<< 48) ||| (byte 7 <<< 56)

/-- The same 64 bits read as a signed `Int`. An `osmId` is positive in practice;
this is two's complement anyway so that a negative one decodes as itself rather
than as 1.8e19. -/
def i64At (b : ByteArray) (i : Nat) : Int :=
  let v := (u64At b i).toNat
  if v ≥ 9223372036854775808 then (v : Int) - 18446744073709551616 else (v : Int)

/-- The absent marker for an optional string — distinct from a length of zero;
see the header. -/
def ABSENT : UInt32 := 0xFFFFFFFF

/-- An optional UTF-8 string at `i`: `(value, bytes consumed including the
length prefix)`. Invalid UTF-8 decodes to `none`, which is the same answer an
absent name gives — a host writing bytes that are not a string is broken, and
the fold's job is to keep going rather than to guess at what it meant. -/
def strAt (b : ByteArray) (i : Nat) : Option String × Nat :=
  let n := u32At b i
  if n == ABSENT then (none, 4)
  else
    let len := n.toNat
    if i + 4 + len > b.size then (none, 4)
    else (String.fromUTF8? (b.extract (i + 4) (i + 4 + len)), 4 + len)

/-- `fuel` bounds the way loop so this is structurally total. -/
private def goWays (b : ByteArray) (fuel off : Nat) (acc : Array Way) : Array Way :=
  match fuel with
  | 0 => acc
  | fuel + 1 =>
    if off + 8 > b.size then acc
    else
      let osmId := i64At b off
      let (name, nBytes) := strAt b (off + 8)
      let (subtype, sBytes) := strAt b (off + 8 + nBytes)
      let ptsOff := off + 8 + nBytes + sBytes
      let n := (u32At b ptsOff).toNat
      goWays b fuel (ptsOff + 4 + n * 16)
        (acc.push { osmId, name, subtype, coords := points b (ptsOff + 4) n })

/-- Decode a whole buffer written in the way format. -/
def decodeWays (b : ByteArray) : Array Way :=
  -- A way costs at least 20 bytes, so the buffer itself caps how many there can
  -- be: a corrupt or hostile count cannot make this loop long.
  goWays b (min (u32At b 0).toNat (b.size / 20 + 1)) 4 #[]

/-! ## The externs

Implemented by whoever links this — see the header. All three take
`(lat, lon, radiusM)` and answer what lies within that disc. -/

@[extern "health_osm_walkable_roads"]
opaque walkableRoadsRaw : Float → Float → Int → ByteArray

@[extern "health_osm_buildings_near"]
opaque buildingsNearRaw : Float → Float → Int → ByteArray

/-- ⚠ `radiusM` is a `Float` here and an `Int` above, and that is not an
oversight: `RoadMatchAnnotate.Env.drivableRoads` takes a `Float` because
`OsmCorridor` passes the corridor radius through untouched, while the walk
pass's disc radius is a whole number of metres by the time it is read. The
lookup key the host matches against is the TS's own, so the two have to arrive
in the shape the TS wrote them in. -/
@[extern "health_osm_drivable_roads"]
opaque drivableRoadsRaw : Float → Float → Float → ByteArray

def walkableRoads (lat lon : Float) (radiusM : Int) : Polylines :=
  decodePolylines (walkableRoadsRaw lat lon radiusM)

def buildingsNear (lat lon : Float) (radiusM : Int) : Polylines :=
  decodePolylines (buildingsNearRaw lat lon radiusM)

def drivableRoads (lat lon radiusM : Float) : Array Way :=
  decodeWays (drivableRoadsRaw lat lon radiusM)

/-! ## Specs

Exercised on literals rather than on whatever a host happens to send, so these
fail on a FORMAT change instead of on a data change. -/

-- The empty answer — what the stub returns, and so what the CLI sees.
#guard decodePolylines (ByteArray.mk #[0, 0, 0, 0]) == #[]

-- A buffer shorter than its own header decodes to nothing, not a panic.
#guard decodePolylines (ByteArray.mk #[1, 0, 0]) == #[]

-- A declared polyline whose points are missing decodes to zeroed points rather
-- than failing. This pins TOTALITY, not a desirable answer: a host that
-- truncates its own reply is broken, and the fold's job is to not crash.
#guard (decodePolylines (ByteArray.mk #[1, 0, 0, 0, 1, 0, 0, 0])).size == 1

-- `u32At` is little-endian, and reads past the end are `0` at both widths.
#guard u32At (ByteArray.mk #[1, 2, 0, 0]) 0 == 513
#guard u32At (ByteArray.mk #[1, 2]) 0 == 0
#guard f64At (ByteArray.mk #[1, 2]) 0 == 0.0

-- A double survives exactly: `1.0` is `0x3FF0000000000000`.
#guard f64At (ByteArray.mk #[0, 0, 0, 0, 0, 0, 240, 63]) 0 == 1.0

-- One polyline of one point at (1.0, 2.0). `2.0` is `0x4000000000000000`.
#guard decodePolylines (ByteArray.mk
  #[1, 0, 0, 0, 1, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 240, 63,
    0, 0, 0, 0, 0, 0, 0, 64]) == #[#[{ lat := 1.0, lon := 2.0 }]]

/-! ### The way format -/

-- The empty answer — what the stub returns on a road leg.
#guard decodeWays (ByteArray.mk #[0, 0, 0, 0]) == #[]

/-- One way: `osmId = 7`, name `"A"`, no subtype, one point at (1.0, 2.0). -/
private def ONE_WAY : ByteArray := ByteArray.mk
  #[1, 0, 0, 0,
    7, 0, 0, 0, 0, 0, 0, 0,
    1, 0, 0, 0, 65,
    255, 255, 255, 255,
    1, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 240, 63,
    0, 0, 0, 0, 0, 0, 0, 64]

#guard decodeWays ONE_WAY ==
  #[{ osmId := 7, name := some "A", subtype := none, coords := #[{ lat := 1.0, lon := 2.0 }] }]

-- Absent is not empty. A zero LENGTH is the name `""`; `0xFFFFFFFF` is `none`.
-- Collapsing the two would change the road matcher's way-switch penalty.
#guard (decodeWays (ByteArray.mk
  #[1, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0,
    255, 255, 255, 255,
    0, 0, 0, 0]))[0]!.name == some ""

-- Multi-byte UTF-8 survives: "é" is 0xC3 0xA9.
#guard (decodeWays (ByteArray.mk
  #[1, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0,
    2, 0, 0, 0, 195, 169,
    255, 255, 255, 255,
    0, 0, 0, 0]))[0]!.name == some "é"

-- Two's complement, so a negative id decodes as itself.
#guard i64At (ByteArray.mk #[255, 255, 255, 255, 255, 255, 255, 255]) 0 == -1
#guard i64At (ByteArray.mk #[7, 0, 0, 0, 0, 0, 0, 0]) 0 == 7

-- Truncation loses ways rather than panicking, at every field boundary.
#guard decodeWays (ByteArray.mk #[1, 0, 0, 0, 7, 0, 0]) == #[]
#guard (decodeWays (ONE_WAY.extract 0 20)).size == 1

end DayEntry.OsmHost
