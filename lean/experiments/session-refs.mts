#!/usr/bin/env -S npx tsx
/**
 * Derive `#guard` expectations for `Verified.Session` from V8.
 *
 * The signed-cookie format is `<value>.<base64url-hmac>`, and the SPLIT is the
 * part with a trap in it: `verifyValue` uses `lastIndexOf(".")`, not
 * `indexOf(".")`, so a value containing dots round-trips. Splitting on the FIRST
 * dot would verify a truncated value against the wrong signature and reject
 * every such cookie — or, worse, accept a prefix.
 *
 * The HMAC itself is not portable to Lean and is not meant to be. What these
 * pin is the framing: which bytes are the value, which are the signature, and
 * what a malformed cookie does.
 *
 * Run: npx tsx lean/experiments/session-refs.mts
 */
import { signValue, verifyValue } from "../../src/middleware/session.js";

const SECRET = "a-test-secret-not-used-anywhere";

const show = (label: string, v: unknown) => console.log(`${label}: ${JSON.stringify(v)}`);

// The plain round trip.
show("round trip", verifyValue(SECRET, signValue(SECRET, "abc")));
// ⚠ THE `lastIndexOf` CASE. A session id is hex so it carries no dots today,
// but `signValue` is used for other values too and the rule is the framing's.
show("value with dots", verifyValue(SECRET, signValue(SECRET, "a.b.c")));
// An empty value is still a value.
show("empty value", verifyValue(SECRET, signValue(SECRET, "")));
// No separator at all.
show("no dot", verifyValue(SECRET, "abcdef"));
// Separator, wrong signature.
show("bad signature", verifyValue(SECRET, "abc.not-the-signature"));
// Right value, signature from a different secret.
show("wrong secret", verifyValue(SECRET, signValue("some-other-secret", "abc")));
// A signature of the right LENGTH but the wrong bytes — the case a
// length-only comparison would wave through.
const good = signValue(SECRET, "abc");
const sig = good.slice(good.lastIndexOf(".") + 1);
const flipped = sig[0] === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
show("same length, wrong bytes", verifyValue(SECRET, `abc.${flipped}`));
// The shape of what `signValue` produces, so the framing is visible.
show("signed shape (dots in output)", signValue(SECRET, "abc").split(".").length);
show("signed value prefix", signValue(SECRET, "abc").startsWith("abc."));

// ⚠ THE SIGNATURES THEMSELVES, so the Rust port has an oracle for its HMAC and
// its base64url. Node's `digest("base64url")` is UNPADDED, and a port that pads
// produces a well-formed signature that never matches. The secret below is a
// fixed test string; nothing in production uses it.
console.log("--- signatures under the fixed test secret ---");
for (const v of ["abc", "", "a.b.c", "deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb"]) {
	console.log(`sign(${JSON.stringify(v)}): ${JSON.stringify(signValue(SECRET, v))}`);
}
