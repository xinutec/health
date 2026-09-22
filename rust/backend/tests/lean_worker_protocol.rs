//! The ask protocol, driven against a FAKE `verified_cli` (#1709).
//!
//! A shell script stands in for Lean: it reads the request, puts one ask on
//! stdout, reads the answer back off stdin and folds it into its result. That
//! is the whole wire — request line, ask line, answer line, reply line — with
//! nothing about the day fold in the way, so a protocol defect fails here with
//! the line that broke rather than as a wrong day.
//!
//! ⚠ ONE PROCESS, ONE FAKE. `verified_cli_path` is resolved once per process
//! from `VERIFIED_CLI`, so this file sets it before the first call and every
//! test in it talks to the fake. Nothing here reaches the real Lean.

#![expect(
    unsafe_code,
    reason = "edition 2024 makes env::set_var unsafe; it is set once, before any thread"
)]

use std::io::Write;

use backend::lean_worker::{self, Answerer, Ask, NoAnswers, parse_ask, result_body};
use serde_json::{Value, json};

fn install_fake() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let dir = std::env::temp_dir().join(format!("fake-verified-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a temp dir");
        let path = dir.join("verified_cli");
        let mut f = std::fs::File::create(&path).expect("the fake is writable");
        // One request per line. A request containing `ask` makes the fake ask
        // for `tzAt(1|2)` and echo the answer; `die` exits mid-call; anything
        // else is answered with the request's own length.
        f.write_all(
            br#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"die"'*) exit 3 ;;
    *'"ask"'*)
      printf '%s\n' '{"ask":{"key":"1|2","what":"tzAt"}}'
      IFS= read -r ans
      printf '{"id":null,"result":{"echo":%s}}\n' "$ans"
      ;;
    *'"plain"'*) printf '%s\n' '{"id":7,"result":"a string reply"}' ;;
    *) printf '{"id":null,"result":{"len":%s}}\n' "${#line}" ;;
  esac
done
"#,
        )
        .expect("the fake is written");
        drop(f);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("the fake is executable");
        }
        // SAFETY: set before any worker is spawned, on the only thread that
        // has run so far in this test binary.
        unsafe { std::env::set_var("VERIFIED_CLI", &path) };
    });
}

struct Fixed(Option<Value>);

impl Answerer for Fixed {
    fn answer(&mut self, ask: &Ask) -> anyhow::Result<Option<Value>> {
        assert_eq!(ask.what, "tzAt");
        assert_eq!(ask.key, "1|2");
        Ok(self.0.clone())
    }
}

#[test]
fn an_ask_is_answered_on_the_same_pipe_and_the_reply_carries_it() {
    install_fake();
    lean_worker::init().expect("the fake starts");

    let c = lean_worker::call(
        r#"{"mode":"ask"}"#,
        &mut Fixed(Some(json!({"answer":{"tz":"Europe/London"}}))),
    )
    .expect("the call completes");
    // The fake echoes the answer LINE it read, so the reply shows exactly what
    // crossed: `{"answer": <row>}`.
    assert_eq!(
        c.body,
        r#"{"echo":{"answer":{"answer":{"tz":"Europe/London"}}}}"#
    );
    assert_eq!(c.asks.len(), 1);
    assert!(c.asks[0].1, "the ask was answered");
    assert!(c.declined().is_empty());
    assert_eq!(c.count("tzAt"), (1, 0));
}

#[test]
fn a_decline_crosses_as_null_and_is_counted() {
    install_fake();
    let c = lean_worker::call(r#"{"mode":"ask"}"#, &mut Fixed(None)).expect("the call completes");
    assert_eq!(c.body, r#"{"echo":{"answer":null}}"#);
    assert_eq!(c.declined().len(), 1);
    assert_eq!(c.count("tzAt"), (0, 1));
}

#[test]
fn a_plain_call_returns_the_result_body_verbatim() {
    install_fake();
    assert_eq!(
        lean_worker::call_plain(r#"{"mode":"plain"}"#).expect("answers"),
        r#""a string reply""#
    );
    // A plain call that is asked something declines it rather than hanging.
    let c = lean_worker::call(r#"{"mode":"ask"}"#, &mut NoAnswers).expect("completes");
    assert_eq!(c.declined().len(), 1);
}

#[test]
fn a_worker_that_dies_fails_that_call_and_the_next_call_gets_a_fresh_one() {
    install_fake();
    let err = lean_worker::call_plain(r#"{"mode":"die"}"#).expect_err("the fake exited");
    assert!(
        format!("{err:#}").contains("exited mid-call"),
        "the failure names what happened: {err:#}"
    );
    // The pool spawned another; the request length round-trips.
    let body = lean_worker::call_plain(r#"{"mode":"len"}"#).expect("a fresh worker answers");
    assert_eq!(body, r#"{"len":14}"#);
}

#[test]
fn a_request_with_a_newline_is_refused_before_it_reaches_the_pipe() {
    install_fake();
    let err = lean_worker::call_plain("{\"mode\":\n\"x\"}").expect_err("refused");
    assert!(format!("{err:#}").contains("one line"));
}

#[test]
fn a_reply_body_is_the_bytes_after_result() {
    assert_eq!(
        result_body(r#"{"id":null,"result":{"a":[1,"2"]}}"#).unwrap(),
        r#"{"a":[1,"2"]}"#
    );
    assert_eq!(result_body(r#"{"id":7,"result":3}"#).unwrap(), "3");
    assert!(result_body(r#"{"error":"parse: x","id":null}"#).is_err());
    assert!(
        result_body(r#"{"error":"#).is_err(),
        "a malformed error line is still an error"
    );
    assert!(result_body("hello").is_err());
}

#[test]
fn an_ask_line_is_recognised_and_nothing_else_is() {
    let a = parse_ask(r#"{"ask":{"key":"1|2","what":"tzAt"}}"#)
        .unwrap()
        .unwrap();
    assert_eq!(a.what, "tzAt");
    assert_eq!(a.key, "1|2");
    assert!(parse_ask(r#"{"id":1,"result":{}}"#).unwrap().is_none());
    assert!(parse_ask(r#"{"ask":"malformed"}"#).is_err());
}
