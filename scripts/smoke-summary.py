#!/usr/bin/env python3
"""Summarise the memory smoke's log: per smoke day, the fold's host-side ledger
beside Lean's ask waits.

    scripts/deploy.sh                       # step 7 writes /tmp/velocity-smoke.log
    scripts/smoke-summary.py [log path]

The smoke job prints each day's `timing` object (routes/velocity.rs). Besides
`lean.*` (Lean's own pass and ask timers) it carries the host ledger
(fold.rs `LEDGER`): `fold.<label>` is milliseconds, `fold.<label>.n` a count —
`db.<query>` per mirror query kind, `cover` the coverage gate's nested Lean
calls, `answer.<table>` the whole answer to one ask table, `reply` the reply
line's serialisation, `boxes.<bucket>` how many coverage rows the gate shipped.
`lean.ask.<table>.wait` minus `fold.answer.<table>` is the pipe.

Sibling instruments, each documented where it lives: `LEAN_DUMP_DIR`
(lean/DayEntry/Host.lean) dumps matcher and naming inputs for
`verified_cli matchprof` and `verified_cli serve` mode `bestplace`;
`DECODE_REQUEST_OUT` (rust/backend/tests/hsmm_decode_corpus.rs) dumps decode
requests; `"chainDebug": true` on `assemblesegments` (lean/ServeEntry.lean)
lists each leg's station candidates and pair terms.
"""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/velocity-smoke.log"
for line in open(path):
    if line.startswith("fold"):
        print(line.rstrip())
        continue
    s = line.strip()
    if not s.startswith("timing"):
        continue
    t = json.loads(s[len("timing"):])

    def g(k):
        return t.get(k, 0)

    waits = {k[len("lean.ask."):-5]: v for k, v in t.items() if k.startswith("lean.ask.") and k.endswith(".wait")}
    ans = {k[len("fold.answer."):]: v for k, v in t.items() if k.startswith("fold.answer.") and not k.endswith(".n")}
    print(
        f"   fold={g('fold')} asks={g('asks')} waits={sum(waits.values())} answers={sum(ans.values())}"
        f" db={g('foldDbMs')} leanSpatial={g('foldLeanMs')} cover={g('fold.cover')}x{g('fold.cover.n')}"
        f" reply={g('fold.reply')}x{g('fold.reply.n')} walk.matcher={g('lean.walk.matcher')} load={g('load')}"
    )
    boxes = ", ".join(f"{k[len('fold.boxes.'):-2]}={v}" for k, v in sorted(t.items()) if k.startswith("fold.boxes."))
    print("   boxes: " + boxes)
    db = [(k[8:], v, t.get(k + ".n", 0)) for k, v in t.items() if k.startswith("fold.db.") and not k.endswith(".n")]
    db.sort(key=lambda x: -x[1])
    print("   db:    " + ", ".join(f"{k}={v}/{n}" for k, v, n in db))
    per = sorted(waits, key=lambda k: -waits[k])
    print(
        "   wait/answer×n: "
        + ", ".join(f"{k}={waits[k]}/{ans.get(k, 0)}x{t.get('fold.answer.' + k + '.n', 0)}" for k in per)
    )
