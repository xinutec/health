import Verified

/-!
# `OsmHost` — the three matcher lookups, answered by the process we run inside

`PassFold.Env`'s `walkEnv`/`roadEnv` are declared shells, and `DayEntry`'s
`UNFED` says why: their "street-network reads and search leaves are 4.31 MiB/day
the wire measurement deliberately left shell-side". That number is the whole
problem. The other six spatial lookups reach the fold through the REQUEST, grown
by `day-serve.ts`'s round loop — ask, be told what was wanted, answer, re-run.
That protocol carries point queries returning small records. It cannot carry
4.31 MiB of road network and building polygon per day across 2-7 rounds.

So these three are answered by CALLING instead of by shipping. Lean declares
them `@[extern]`; whoever links the fold provides them:

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
which carries `osmId`/`name`/`subtype` as well, and is NOT this shape — it is
deliberately left for a second format rather than smuggled through this one.

# Deliberately not in `Verified`

That library has no `Json`, no `IO` and no `@[extern]`, and its folds are pure so
their `#guard` specs mean something. A callback into a host is the opposite of
that. `DayEntry` is already the impure layer — it is where the parser lives — so
the boundary goes here.
-/

namespace DayEntry.OsmHost

open Verified.Geo.WalkableRoute (Pt)

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

/-! ## The externs

Implemented by whoever links this — see the header. Both take
`(lat, lon, radiusM)` and answer the polylines within that disc. -/

@[extern "health_osm_walkable_roads"]
opaque walkableRoadsRaw : Float → Float → Int → ByteArray

@[extern "health_osm_buildings_near"]
opaque buildingsNearRaw : Float → Float → Int → ByteArray

def walkableRoads (lat lon : Float) (radiusM : Int) : Polylines :=
  decodePolylines (walkableRoadsRaw lat lon radiusM)

def buildingsNear (lat lon : Float) (radiusM : Int) : Polylines :=
  decodePolylines (buildingsNearRaw lat lon radiusM)

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

end DayEntry.OsmHost
