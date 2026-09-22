//! Answering the fold from a golden fixture's recorded `osmTrace` (#1709).
//!
//! A fixture carries two things the fold can be answered from: `osmRowSet`, the
//! raw mirror rows the answerer scores through Lean
//! ([`crate::rowset_answerer`]), and `osmTrace`, the ANSWERS production gave on
//! the day it was captured — one section per table, keyed by the question. This
//! is the second: a replay asks the trace first and the row set for whatever the
//! trace does not hold, so a day replays against the roads it was blessed on.
//!
//! # Two kinds of key
//!
//! The seven answerer tables are keyed as the fold spells them — bit patterns
//! joined by `|` — and matched EXACTLY. The three matcher reads
//! (`walkableRoads`, `buildingsNear`, `drivableRoads`) are keyed by the
//! coordinates as decimal text and matched QUANTISED, to 1e-9° and 1e-6 m,
//! because the two arms that wrote and read them compute a corridor centre one
//! ULP apart on ~0.5% of rows (`Float.cos` differs between runtimes) and a
//! disc's address is not a 17-digit quantity. Production is unaffected either
//! way: a live mirror answers by distance, not by key.
//!
//! # ⚠ Presence of a section is not presence of a trace
//!
//! 2026-08-12 carries all three matcher sections as EMPTY objects. Count the
//! entries ([`TraceAnswerer::has_walk_capture`]) before calling a day
//! measurable for walks; a harness that never answers the walk reads measures
//! the matcher by not running it (#1418).

use std::collections::HashMap;

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::fold_payload::{bits, lookup_rows};
use crate::lean::{Answerer, Ask};

/// The three lookups the walk and road matchers make. Counted apart because a
/// harness that never answers them measures the matchers by not running them
/// (#1418), and that has to be visible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MatcherRead {
    Walkable,
    Buildings,
    Drivable,
}

impl MatcherRead {
    pub const ALL: [Self; 3] = [Self::Walkable, Self::Buildings, Self::Drivable];

    /// The table name the fold asks with.
    pub fn name(self) -> &'static str {
        match self {
            Self::Walkable => "walkableRoads",
            Self::Buildings => "buildingsNear",
            Self::Drivable => "drivableRoads",
        }
    }

    /// Parsed once, at the boundary where an ask arrives.
    pub fn parse(what: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|r| r.name() == what)
    }
}

/// Which of the three matcher sections to answer from. Withholding one
/// attributes a measured change to ONE read rather than to "the trace".
#[derive(Debug, Clone, Copy)]
pub struct Sections {
    pub walkable: bool,
    pub buildings: bool,
    pub drivable: bool,
}

impl Sections {
    pub const ALL: Self = Self {
        walkable: true,
        buildings: true,
        drivable: true,
    };

    fn wants(self, read: MatcherRead) -> bool {
        match read {
            MatcherRead::Walkable => self.walkable,
            MatcherRead::Buildings => self.buildings,
            MatcherRead::Drivable => self.drivable,
        }
    }
}

/// A quantised `(lat, lon, radius)`; see the module header.
type QKey = (i64, i64, i64);

fn quantise(v: f64) -> i64 {
    (v * 1e9).round() as i64
}

fn quantise_r(v: f64) -> i64 {
    (v * 1e6).round() as i64
}

/// The decimal-text key a matcher section is written under.
fn parse_text_key(k: &str) -> Option<(f64, f64, f64)> {
    let mut it = k.split('|');
    Some((
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
    ))
}

/// The bit-pattern key the fold asks with.
fn parse_bits_key(k: &str) -> Option<(f64, f64, f64)> {
    let mut it = k.split('|');
    let mut f = || it.next()?.parse::<u64>().ok().map(f64::from_bits);
    Some((f()?, f()?, f()?))
}

fn qkey((lat, lon, r): (f64, f64, f64)) -> QKey {
    (quantise(lat), quantise(lon), quantise_r(r))
}

/// A `[lat, lon]` pair or a `{lat, lon}` object — the fixtures spell a way's
/// vertices the first way and a building ring's the second.
fn parse_pair(v: &Value) -> Option<(f64, f64)> {
    if let Some(a) = v.as_array() {
        return Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?));
    }
    Some((v.get("lat")?.as_f64()?, v.get("lon")?.as_f64()?))
}

fn pair_bits((lat, lon): (f64, f64)) -> Value {
    json!([bits(lat), bits(lon)])
}

/// A recorded way, as the fold reads it: coordinates as bit patterns.
/// `Err` names a vertex that did not parse — a shape the parser drops is the
/// defect that once decoded every building ring to zero vertices.
fn way_to_wire(w: &Value) -> Result<Value, String> {
    let coords = w
        .get("coords")
        .and_then(Value::as_array)
        .ok_or("a way with no coords")?;
    let mut out = Vec::with_capacity(coords.len());
    for c in coords {
        out.push(pair_bits(
            parse_pair(c).ok_or("a way vertex that is not a pair")?,
        ));
    }
    if out.is_empty() {
        return Err("a way with ZERO vertices".into());
    }
    Ok(json!({
        "osmId": w.get("osmId").and_then(Value::as_i64).ok_or("a way with no osmId")?,
        "name": w.get("name").cloned().unwrap_or(Value::Null),
        "subtype": w.get("subtype").cloned().unwrap_or(Value::Null),
        "coords": out,
    }))
}

fn ring_to_wire(r: &Value) -> Result<Value, String> {
    let pts = r.as_array().ok_or("a ring that is not an array")?;
    let mut out = Vec::with_capacity(pts.len());
    for p in pts {
        out.push(pair_bits(
            parse_pair(p).ok_or("a ring vertex that is not a pair")?,
        ));
    }
    if out.is_empty() {
        return Err("a ring with ZERO vertices".into());
    }
    Ok(Value::Array(out))
}

fn section_to_wire(read: MatcherRead, v: &Value) -> Result<Value, String> {
    let items = v.as_array().ok_or("a section entry that is not an array")?;
    let mut out = Vec::with_capacity(items.len());
    for (i, it) in items.iter().enumerate() {
        let w = if read == MatcherRead::Buildings {
            ring_to_wire(it)
        } else {
            way_to_wire(it)
        }
        .map_err(|e| format!("entry {i} of {}: {e}", items.len()))?;
        out.push(w);
    }
    Ok(Value::Array(out))
}

/// The recorded answers of one fixture, indexed for the fold's asks.
pub struct TraceAnswerer {
    tables: HashMap<(String, String), Value>,
    matcher: HashMap<(MatcherRead, QKey), Value>,
    walk_keys: usize,
}

impl TraceAnswerer {
    /// Index a fixture's `inputs.osmTrace` (and the capture's own `tzAt` /
    /// `bestPlace` sections, when a caller has them). `label` names the fixture
    /// in errors.
    pub fn new(
        trace: Option<&Value>,
        cap: Option<&Value>,
        label: &str,
        sections: Sections,
    ) -> Result<Self, String> {
        let mut tables = HashMap::new();
        for (what, key, row) in lookup_rows(
            trace,
            cap.and_then(|c| c.get("tzAt")),
            cap.and_then(|c| c.get("bestPlace")),
        )
        .map_err(|e| format!("{label}: {e:#}"))?
        {
            tables.insert((what, key), row);
        }

        let mut matcher = HashMap::new();
        let mut walk_keys = 0;
        for read in MatcherRead::ALL {
            let what = read.name();
            let Some(sec) = trace.and_then(|t| t.get(what)).and_then(Value::as_object) else {
                continue;
            };
            if read != MatcherRead::Drivable {
                walk_keys += sec.len();
            }
            if !sections.wants(read) {
                continue;
            }
            for (k, v) in sec {
                let Some(parsed) = parse_text_key(k) else {
                    return Err(format!("{label}: {what} key {k:?} is not lat|lon|radius"));
                };
                let wire = section_to_wire(read, v)
                    .map_err(|e| format!("{label}: {what} key {k}: {e}"))?;
                matcher.insert((read, qkey(parsed)), wire);
            }
        }
        Ok(Self {
            tables,
            matcher,
            walk_keys,
        })
    }

    /// As [`new`](Self::new), from a whole fixture document.
    pub fn from_fixture(fx: &Value, label: &str, sections: Sections) -> Result<Self, String> {
        Self::new(fx.pointer("/inputs/osmTrace"), None, label, sections)
    }

    /// Did the capture record any walk read at all? A day without one cannot
    /// be graded for walks against this trace.
    pub fn has_walk_capture(&self) -> bool {
        self.walk_keys > 0
    }
}

impl TraceAnswerer {
    /// The recorded answer, if the trace holds one. Read-only, so one trace
    /// serves every arm of a day's replay.
    pub fn lookup(&self, ask: &Ask) -> Option<Value> {
        if let Some(read) = MatcherRead::parse(&ask.what) {
            let k = parse_bits_key(&ask.key)?;
            return self.matcher.get(&(read, qkey(k))).cloned();
        }
        self.tables
            .get(&(ask.what.clone(), ask.key.clone()))
            .cloned()
    }
}

impl Answerer for TraceAnswerer {
    fn answer(&mut self, ask: &Ask) -> Result<Option<Value>> {
        Ok(self.lookup(ask))
    }
}

impl Answerer for &TraceAnswerer {
    fn answer(&mut self, ask: &Ask) -> Result<Option<Value>> {
        Ok(self.lookup(ask))
    }
}

/// Record the three matcher reads' answers as an `osmTrace` while another
/// answerer supplies them — the writer for a new golden day (#1660). The other
/// seven sections come from `rowset_capture`, which records the ROWS.
pub struct RecordingAnswerer<A> {
    inner: A,
    sections: Map<String, Value>,
}

impl<A: Answerer> RecordingAnswerer<A> {
    pub fn new(inner: A) -> Self {
        Self {
            inner,
            sections: Map::new(),
        }
    }

    /// The recorded sections, in the fixture's own shape: keys as full-precision
    /// decimal text, way vertices as `[lat, lon]`, ring vertices as `{lat, lon}`.
    pub fn take(&mut self) -> Value {
        Value::Object(std::mem::take(&mut self.sections))
    }
}

fn unbits(v: &Value) -> Option<f64> {
    v.as_str()?.parse::<u64>().ok().map(f64::from_bits)
}

fn pair_plain(v: &Value, as_object: bool) -> Value {
    let (lat, lon) = v
        .as_array()
        .and_then(|a| Some((unbits(a.first()?)?, unbits(a.get(1)?)?)))
        .unwrap_or((f64::NAN, f64::NAN));
    if as_object {
        json!({ "lat": lat, "lon": lon })
    } else {
        json!([lat, lon])
    }
}

fn wire_to_fixture(read: MatcherRead, v: &Value) -> Value {
    let items = v.as_array().cloned().unwrap_or_default();
    Value::Array(
        items
            .iter()
            .map(|it| {
                if read == MatcherRead::Buildings {
                    Value::Array(
                        it.as_array()
                            .into_iter()
                            .flatten()
                            .map(|p| pair_plain(p, true))
                            .collect(),
                    )
                } else {
                    json!({
                        "osmId": it.get("osmId").cloned().unwrap_or(Value::Null),
                        "name": it.get("name").cloned().unwrap_or(Value::Null),
                        "subtype": it.get("subtype").cloned().unwrap_or(Value::Null),
                        "coords": it.get("coords").and_then(Value::as_array).into_iter().flatten()
                            .map(|p| pair_plain(p, false)).collect::<Vec<_>>(),
                    })
                }
            })
            .collect(),
    )
}

impl<A: Answerer> Answerer for RecordingAnswerer<A> {
    fn answer(&mut self, ask: &Ask) -> Result<Option<Value>> {
        let answer = self.inner.answer(ask)?;
        if let (Some(v), Some((lat, lon, r)), Some(read)) = (
            &answer,
            parse_bits_key(&ask.key),
            MatcherRead::parse(&ask.what),
        ) {
            // ⚠ FULL PRECISION: the key is parsed back by `parse_text_key` and
            // quantised; a rounded format would land in a different bucket
            // than the live lookup and the replay would miss every key it had
            // just captured.
            self.sections
                .entry(ask.what.clone())
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .map(|m| m.insert(format!("{lat}|{lon}|{r}"), wire_to_fixture(read, v)));
        }
        Ok(answer)
    }
}

/// What a capture was taken under, for stamping into a fixture's `meta`.
///
/// ⚠ **A FIXTURE THAT DOES NOT RECORD THESE CANNOT NOTICE THEM MOVING.** Each
/// one changes what the mirror is ASKED or what it may return, and none of
/// them is part of any key a fixture holds — so a change to one alters
/// production and alters nothing a gate replays (#1071, #328).
#[must_use]
pub fn capture_inputs() -> Value {
    json!({
        "roadCorridorMarginM": crate::mirror_source::ROAD_CORRIDOR_MARGIN_M,
        "candidateLimit": crate::mirror_source::CANDIDATE_LIMIT,
    })
}

/// Refuse a fixture captured under inputs this build no longer uses.
///
/// ⚠ **ABSENT IS NOT A MISMATCH.** The fixtures captured before this existed
/// carry no stamp and must keep working. Only a stamp that is PRESENT and
/// DIFFERENT is a refusal.
pub fn check_capture_inputs(meta: &Value) -> Result<(), String> {
    let Some(stamped) = meta.get("captureInputs").and_then(Value::as_object) else {
        return Ok(());
    };
    let now = capture_inputs();
    let mut moved: Vec<String> = Vec::new();
    for (k, was) in stamped {
        let is = now.get(k);
        if is != Some(was) {
            moved.push(format!(
                "{k}: captured under {was}, this build uses {}",
                is.map_or("(nothing of that name)".to_string(), ToString::to_string)
            ));
        }
    }
    if moved.is_empty() {
        return Ok(());
    }
    Err(format!(
        "this fixture was captured under different inputs and replaying it would \
         compare the wrong things — {}. Re-capture the day, or restore the constant; \
         do NOT bless around it, because every gate stays green either way (#1071)",
        moved.join("; ")
    ))
}
