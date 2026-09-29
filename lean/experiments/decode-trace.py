#!/usr/bin/env python3
"""Lay out `verified_cli decodetrace` output as a minute × state matrix (#238).

    verified_cli decodetrace < request-with-window.json > trace.json
    decode-trace.py trace.json 'train|Victoria Line,train|Metropolitan Line,walking'

The request is an `assemblesegments` request plus `"window": [tsFrom, tsTo]`
(`DECODE_REQUEST_OUT=<dir>` on `hsmm_decode_corpus` writes each day's).
Columns are state keys (`StateSpace.stateKey`); cells are the emission per
minute, `-inf` where the state is absent; `g` = a fix that minute, `c` = the
train generator covers it, `lines` = what it vouches, `e[...]` = a train
state's non-zero entry prior.
"""
import datetime
import json
import sys

d = json.load(open(sys.argv[1]))
cols = sys.argv[2].split(',')


def hm(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime('%H:%M')


def short(k):
    return k.replace('train|', '').replace(' Line', '')[:9]


print('time  g c ' + ' '.join(f'{short(c):>9}' for c in cols) + '   lines')
tot = {c: 0.0 for c in cols}
for m in d['minutes']:
    by = {s['key']: s for s in m['states']}
    cells = []
    for c in cols:
        s = by.get(c)
        v = None if s is None else s['emit']
        cells.append('     -inf' if v is None else f'{v:9.2f}')
        if v is not None:
            tot[c] += v
    extra = ''
    for c in cols:
        s = by.get(c)
        if s and s['entry'] not in (0, None) and c.startswith('train|'):
            extra += f" e[{short(c)}]={s['entry']:.1f}"
    lines = ','.join(x.replace(' Line', '') for x in m['lines'])
    print(f"{hm(m['ts'])} {int(m['gps'])} {int(m['covered'])} " + ' '.join(cells) + '   ' + lines + extra)
print('sum        ' + ' '.join(f'{tot[c]:9.1f}' for c in cols))
