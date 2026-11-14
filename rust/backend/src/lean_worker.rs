//! The Lean process, and the pipe every decision crosses.
//!
//! `verified_cli serve` reads one NDJSON request per line and writes one reply
//! per line. This module pools those processes and drives the protocol,
//! including asks: a handler may write `{"ask":{"what","key"}}` and block until
//! it reads `{"answer": row}`, or `{"answer": null}` for a decline.
//!
//! A process, not a linked library: serialisation is cheap (a day is ~60
//! lookups and one 1.5 MiB request), while linking needed stderr redirection
//! around every call and crashed when Lean was reached before its runtime was
//! up. Lean's stderr is ours.
//!
//! A pool, because asks nest: answering one may itself call Lean (`osmspatial`,
//! `osmcoverage`) while the asking worker blocks, so a nested call takes
//! another worker. Idle workers beyond `MAX_IDLE` are dropped, and so is one
//! that has served `LEAN_WORKER_RECYCLE_CALLS` requests (default 500), since
//! the fold's heap grows across days.
//!
//! A worker dying mid-call fails that call; the next spawns afresh. A call over
//! `LEAN_CALL_TIMEOUT_S` (default 600) kills its worker by pid. Nothing retries:
//! the caller knows whether the request can be dropped.

use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock, mpsc};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::Value;

/// One question the fold put to its host: the table and the key, spelled as the
/// fold spells it (bit patterns joined by `|`, or a bare name).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Ask {
    pub what: String,
    pub key: String,
}

/// Answers asks during a call. `Ok(None)` is a decline — "I cannot vouch for
/// this ground" — and is recorded, never treated as an error; an `Err` fails
/// the call.
pub trait Answerer {
    fn answer(&mut self, ask: &Ask) -> Result<Option<Value>>;
}

/// Declines everything. What a mode that asks nothing is called with, and how a
/// day is measured: run it with this and every ask is a key the day needs.
#[derive(Debug, Default)]
pub struct NoAnswers;

impl Answerer for NoAnswers {
    fn answer(&mut self, _ask: &Ask) -> Result<Option<Value>> {
        Ok(None)
    }
}

/// Answer from the first, and where it declines, from the second.
pub struct Chain<A, B>(pub A, pub B);

impl<A: Answerer, B: Answerer> Answerer for Chain<A, B> {
    fn answer(&mut self, ask: &Ask) -> Result<Option<Value>> {
        if let Some(v) = self.0.answer(ask)? {
            return Ok(Some(v));
        }
        self.1.answer(ask)
    }
}

/// What one call produced: the reply body, verbatim, and every ask it made with
/// whether it was answered.
#[derive(Debug)]
pub struct Called {
    /// The `result` of the reply line, as Lean wrote it — not re-serialised, so
    /// a caller comparing against `verified_cli` output compares bytes.
    pub body: String,
    pub asks: Vec<(Ask, bool)>,
}

impl Called {
    /// The asks nothing answered.
    pub fn declined(&self) -> Vec<Ask> {
        self.asks
            .iter()
            .filter(|(_, ok)| !ok)
            .map(|(a, _)| a.clone())
            .collect()
    }

    /// `(answered, declined)` for the asks of one table.
    pub fn count(&self, what: &str) -> (u64, u64) {
        self.asks
            .iter()
            .filter(|(a, _)| a.what == what)
            .fold(
                (0, 0),
                |(h, m), (_, ok)| {
                    if *ok { (h + 1, m) } else { (h, m + 1) }
                },
            )
    }
}

/// Idle workers kept for the next call; the rest are dropped on return.
const MAX_IDLE: usize = 2;

/// Where `verified_cli` is, in order of preference, resolved once:
///
///   1. `$VERIFIED_CLI` — what the image sets;
///   2. `lean/verified_cli` under the current directory — the image's layout;
///   3. what `build.rs` built — the dev tree and the tests.
pub fn verified_cli_path() -> Result<&'static PathBuf> {
    static PATH: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    PATH.get_or_init(|| {
        let candidates: Vec<PathBuf> = [
            std::env::var_os("VERIFIED_CLI").map(PathBuf::from),
            Some(PathBuf::from("lean/verified_cli")),
            option_env!("VERIFIED_CLI_BUILD").map(PathBuf::from),
        ]
        .into_iter()
        .flatten()
        .collect();
        candidates
            .iter()
            .find(|p| p.is_file())
            .cloned()
            .ok_or_else(|| {
                format!(
                    "no verified_cli binary: tried {}",
                    candidates
                        .iter()
                        .map(|p| p.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })
    })
    .as_ref()
    .map_err(|e| anyhow!("{e}"))
}

fn call_timeout() -> Duration {
    Duration::from_secs(
        std::env::var("LEAN_CALL_TIMEOUT_S")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(600),
    )
}

fn recycle_after() -> u64 {
    std::env::var("LEAN_WORKER_RECYCLE_CALLS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(500)
}

struct Worker {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    /// Lines off the child's stdout, read by a thread so a call can wait with a
    /// timeout. `None` on the channel is EOF: the child is gone.
    lines: mpsc::Receiver<std::io::Result<String>>,
    calls: u64,
}

impl Drop for Worker {
    fn drop(&mut self) {
        // By pid, through the handle we own. Closing stdin would end the loop
        // too, but a worker being dropped is one we no longer trust.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Worker {
    fn spawn() -> Result<Self> {
        let path = verified_cli_path()?;
        let mut child = Command::new(path)
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("spawning {}", path.display()))?;
        let stdin = child.stdin.take().context("the child has no stdin")?;
        let stdout = child.stdout.take().context("the child has no stdout")?;
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("lean-stdout".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) => break,
                        Ok(_) => {
                            if line.ends_with('\n') {
                                line.pop();
                            }
                            if tx.send(Ok(line)).is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(Err(e));
                            break;
                        }
                    }
                }
            })
            .context("spawning the stdout reader")?;
        Ok(Self {
            child,
            stdin: BufWriter::new(stdin),
            lines: rx,
            calls: 0,
        })
    }

    fn send(&mut self, line: &str) -> Result<()> {
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|()| self.stdin.write_all(b"\n"))
            .and_then(|()| self.stdin.flush())
            .context("writing to verified_cli")
    }

    fn next_line(&self, timeout: Duration) -> Result<String> {
        match self.lines.recv_timeout(timeout) {
            Ok(Ok(line)) => Ok(line),
            Ok(Err(e)) => Err(anyhow!("reading from verified_cli: {e}")),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                bail!("verified_cli exited mid-call (pid {})", self.child.id())
            }
            Err(mpsc::RecvTimeoutError::Timeout) => bail!(
                "verified_cli (pid {}) answered nothing in {}s",
                self.child.id(),
                timeout.as_secs()
            ),
        }
    }

    fn run(&mut self, request: &str, answerer: &mut dyn Answerer) -> Result<Called> {
        if request.contains('\n') {
            bail!("a request must be one line");
        }
        self.calls += 1;
        self.send(request)?;
        let timeout = call_timeout();
        let mut asks = Vec::new();
        // Memoised per call: within one request an answer is a function of
        // the key, and the fold asks some keys twice. Every ask is still
        // recorded. The memo holds the reply line, not the `Value` tree: a
        // walkable-roads answer as a tree is ten times its text, and holding
        // trees made the fold's working set big enough to OOM the pod.
        let mut memo: std::collections::HashMap<Ask, (std::sync::Arc<str>, bool)> =
            Default::default();
        loop {
            let line = self.next_line(timeout)?;
            if let Some(ask) = parse_ask(&line)? {
                // A remembered walk: answered from the store, and not
                // recorded — it is not a question about the world, so no count,
                // capture or fetch queue may see it.
                if ask.what.starts_with("memo.") {
                    let answer = crate::walk_memo::answer(&ask).unwrap_or(Value::Null);
                    self.send(&serde_json::json!({ "answer": answer }).to_string())?;
                    continue;
                }
                let (reply, answered) = match memo.get(&ask) {
                    Some((r, ok)) => (std::sync::Arc::clone(r), *ok),
                    None => {
                        let answer = answerer
                            .answer(&ask)
                            .with_context(|| format!("answering {}({})", ask.what, ask.key))?;
                        let answered = answer.is_some();
                        let t0 = std::time::Instant::now();
                        let reply: std::sync::Arc<str> =
                            serde_json::json!({ "answer": answer.unwrap_or(Value::Null) })
                                .to_string()
                                .into();
                        crate::fold::LEDGER.charge("reply", t0.elapsed().as_nanos() as u64);
                        memo.insert(ask.clone(), (std::sync::Arc::clone(&reply), answered));
                        (reply, answered)
                    }
                };
                self.send(&reply)?;
                asks.push((ask, answered));
                continue;
            }
            return Ok(Called {
                body: result_body(&line)?,
                asks,
            });
        }
    }
}

#[derive(Deserialize)]
struct AskLine {
    ask: Ask2,
}

#[derive(Deserialize)]
struct Ask2 {
    what: String,
    key: String,
}

/// `Some(ask)` for an ask line, `None` for anything else. Public for the
/// protocol test, which pins the wire shapes without a Lean.
pub fn parse_ask(line: &str) -> Result<Option<Ask>> {
    if !line.starts_with("{\"ask\":") {
        return Ok(None);
    }
    let a: AskLine = serde_json::from_str(line)
        .with_context(|| format!("an ask this side cannot read: {line:.200}"))?;
    Ok(Some(Ask {
        what: a.ask.what,
        key: a.ask.key,
    }))
}

/// The body of `{"id":…,"result":BODY}`, as text, so tests can compare bytes
/// with `verified_cli`'s own output. `Json.compress` sorts keys, so `"result"`
/// is last and the body runs to the closing brace.
pub fn result_body(line: &str) -> Result<String> {
    if line.starts_with("{\"error\"") {
        #[derive(Deserialize)]
        struct E {
            error: String,
        }
        // An error line that is not even well-formed is reported as the bytes
        // it was, not as an empty message.
        let e: E = serde_json::from_str(line)
            .with_context(|| format!("verified_cli wrote a malformed error line: {line:.200}"))?;
        bail!("verified_cli: {}", e.error);
    }
    let Some(i) = line.find("\"result\":") else {
        bail!("verified_cli wrote a line that is neither an ask nor a reply: {line:.200}");
    };
    let body = &line[i + "\"result\":".len()..];
    let Some(body) = body.strip_suffix('}') else {
        bail!("verified_cli reply does not close: {line:.200}");
    };
    Ok(body.to_string())
}

static POOL: Mutex<Vec<Worker>> = Mutex::new(Vec::new());

fn take() -> Result<Worker> {
    let idle = POOL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .pop();
    match idle {
        Some(w) => Ok(w),
        None => Worker::spawn(),
    }
}

fn give_back(w: Worker) {
    if w.calls >= recycle_after() {
        return; // dropped: killed
    }
    let mut pool = POOL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if pool.len() < MAX_IDLE {
        pool.push(w);
    }
}

/// Start one worker, so a process that cannot reach Lean fails at startup
/// rather than on its first request. Idempotent.
pub fn init() -> Result<()> {
    static INIT: OnceLock<Result<(), String>> = OnceLock::new();
    INIT.get_or_init(|| Worker::spawn().map(give_back).map_err(|e| format!("{e:#}")))
        .clone()
        .map_err(|e| anyhow!("{e}"))
}

/// One request, with an answerer for whatever it asks.
pub fn call(request: &str, answerer: &mut dyn Answerer) -> Result<Called> {
    let mut w = take()?;
    match w.run(request, answerer) {
        Ok(c) => {
            give_back(w);
            Ok(c)
        }
        Err(e) => Err(e), // `w` drops here: killed, not returned
    }
}

/// One request that asks nothing. An ask that does arrive is declined and the
/// decline is reported, because a mode that started asking is a change worth
/// seeing.
pub fn call_plain(request: &str) -> Result<String> {
    let c = call(request, &mut NoAnswers)?;
    if !c.asks.is_empty() {
        eprintln!(
            "lean: a plain call made {} ask(s), all declined — first: {}({})",
            c.asks.len(),
            c.asks[0].0.what,
            c.asks[0].0.key
        );
    }
    Ok(c.body)
}
