"""Fit the venue ranking's constants on the confirmed corpus stays (#325).

Reads /tmp/venuefit.log (VENUEFIT/VENUETOP lines from lean/experiments/venue-fit-trace.patch)
and /tmp/truth-rows.jsonl (TRUTH_ROWS_OUT from the corpus gate's truth grader).
`grid` sweeps σ, the open-hours support, the base-rate clamp and the near-field radius.
A Python copy of `rankVenues`; PARITY against the Lean pick is printed first and must be total
before any number below it means anything (2026-09-28: 139/139)."""
import json, re, math, sys, itertools, time, collections, os

VENUE_TYPES = {"amenity", "tourism", "shop"}
PRIOR_TYPES = {"amenity", "tourism", "shop", "leisure"}
NEVER_DEST = set()  # already filtered in the dump

LOG = os.environ.get('VENUEFIT_LOG', '/tmp/venuefit.log')
ROWS = os.environ.get('TRUTH_ROWS', '/tmp/truth-rows.jsonl')

def load_stays():
    stays = []
    seen = {}
    for l in open(LOG):
        i = l.find('VENUEFIT ')
        if i >= 0:
            j = json.loads(l[i+9:].strip())
            key = (j['s'], j['e'])
            if key in seen: continue   # the same stay ranked twice (two arms / re-enrich)
            seen[key] = j; stays.append(j); continue
        i = l.find('VENUETOP ')
        if i >= 0:
            j = json.loads(l[i+9:].strip())
            st = seen.get((j['s'], j['e']))
            if st is not None and 'top' not in st: st['top'] = j
    return stays

def parity(data_all, p):
    bad = []
    for st in data_all:
        if 'top' not in st: continue
        r = rank(st, p)
        if not r: continue
        mine = r[0]
        if norm(mine['n']) != norm(st['top']['n']) or abs(mine['total'] - st['top']['tot']) > 1e-4:
            bad.append((date_of(st['s']), time.strftime('%H:%MZ', time.gmtime(st['s'])), st['top']['n'], round(st['top']['tot'],3), mine['n'], round(mine['total'],3)))
    return bad

def load_rows():
    rows = collections.defaultdict(list)
    for l in open(ROWS):
        j = json.loads(l)
        rows[j['date']].extend(j['rows'])
    return rows

def norm(s): return re.sub(r'\s+', ' ', (s or '').strip().lower())

def date_of(ts): return time.strftime('%Y-%m-%d', time.gmtime(ts))

def label_for(stay, rows):
    best = None
    for r in rows:
        t = r.get('truth') or {}
        if t.get('mode') != 'stationary' or not t.get('place'): continue
        if r.get('status') not in ('correct', 'wrong'): continue
        if (r.get('provenance') or '') in ('unspecified', 'untrusted', 'pipeline'): continue
        a, b = r['startTs'], r['endTs']
        ov = min(b, stay['e']) - max(a, stay['s'])
        short = min(b - a, stay['e'] - stay['s'])
        if short <= 0 or ov <= 0: continue
        if ov / short >= 0.5 and (best is None or ov > best[0]):
            best = (ov, t['place'], r['status'], r.get('provenance'))
    return best

class P:
    def __init__(self, sigma=40.0, venue=1.5, open_=0.7, closed=-2.5, base_lo=-2.0, base_hi=1.5,
                 dwell_lo=-2.0, dwell_hi=1.2, hour_lo=-1.5, hour_hi=1.2, near=12.0, floor=-1.5, nf_min=0.0):
        self.__dict__.update(locals()); del self.__dict__['self']
    def __repr__(self):
        return f"σ={self.sigma:g} open={self.open_:g} base=[{self.base_lo:g},{self.base_hi:g}] near={self.near:g} nf_min={self.nf_min:g} venue={self.venue:g}"

def clamp(x, lo, hi): return min(hi, max(lo, x))

def rank(stay, p):
    cands = []
    for c in stay['c']:
        isv = c['t'] in VENUE_TYPES
        dist = -0.5 * (c['d'] / p.sigma) ** 2
        venue = p.venue if isv else 0.0
        shape = None
        if c['t'] in PRIOR_TYPES and not (c['b'] == 0 and c['dw'] == 0 and c['hr'] == 0):
            shape = clamp(c['b'], p.base_lo, p.base_hi) + clamp(c['dw'], p.dwell_lo, p.dwell_hi) + clamp(c['hr'], p.hour_lo, p.hour_hi)
        hours = None
        if c['of'] is not None:
            hours = p.closed + c['of'] * (p.open_ - p.closed)
        total = dist + venue + (shape or 0.0) + (hours or 0.0)
        # NEAR_FIELD_MIN_NATS (2026-09-28): the veto goes only to a candidate whose own total is at least neutral.
        nf = isv and not c['rg'] and c['d'] <= p.near and (hours is None or hours >= 0) and total >= p.nf_min
        cands.append(dict(c, total=total, nf=nf))
    def key(c):
        return (0 if c['enc'] else 1, 0 if c['nf'] else 1, c['d'] if c['nf'] else 0.0, -c['total'], c['d'], c['n'].lower())
    cands.sort(key=key)
    # stable sort in Lean is insertion by `before`; ties keep input order — close enough.
    return cands

def predict(stay, p):
    r = rank(stay, p)
    if not r: return None, r
    top = r[0]
    if not (top['enc'] or top['total'] >= p.floor): return None, r   # falls through to the address chain
    return top['n'], r

def evaluate(data, p, verbose=False):
    right = 0; wrong = []
    for stay, lab in data:
        pred, r = predict(stay, p)
        ok = pred is not None and norm(pred) == norm(lab)
        right += ok
        if not ok: wrong.append((date_of(stay['s']), time.strftime('%H:%MZ', time.gmtime(stay['s'])), lab, pred))
    return right, wrong

if __name__ == '__main__':
    stays = load_stays(); rows = load_rows()
    data = []; unreachable = []
    for st in stays:
        lab = label_for(st, rows.get(date_of(st['s']), []))
        if not lab: continue
        names = {norm(c['n']) for c in st['c']}
        if norm(lab[1]) not in names:
            unreachable.append((date_of(st['s']), time.strftime('%H:%MZ', time.gmtime(st['s'])), lab[1], lab[2])); continue
        data.append((st, lab[1]))
    print(f"{len(stays)} ranked stays, {len(data)} with a confirmed venue among the candidates, {len(unreachable)} confirmed venues NOT among the candidates (coverage, not ranking)")
    for u in unreachable: print('   unreachable', u)
    base = P()
    bad = parity(stays, base)
    print(f"\nPARITY of this copy with the Lean ranking under the shipped constants: {len(stays)-len(bad)}/{len(stays)} stays agree on the top and its total")
    for b in bad[:15]: print('   ≠', b)
    right, wrong = evaluate(data, base)
    print(f"\nAS SHIPPED {base}: {right}/{len(data)} right")
    for w in wrong: print('   ✗', w)
    if len(sys.argv) > 1 and sys.argv[1] == 'nfmin':
        for m in [0.5, 0.25, 0, -0.25, -0.5, -0.75, -1.0, -1.5]:
            r, w = evaluate(data, P(nf_min=m))
            print(f"   nf_min={m:g}: {r}/{len(data)} right   wrong: {[(d,t,l,pr) for d,t,l,pr in w]}"[:600])
    if len(sys.argv) > 1 and sys.argv[1] == 'grid':
        best = []
        for sigma, open_, base_lo, near, venue in itertools.product([15,20,25,30,40,60],[0,0.35,0.7],[-2,-1,-0.5,0],[8,12,20,30],[1.5]):
            p = P(sigma=sigma, open_=open_, base_lo=base_lo, near=near, venue=venue)
            r, w = evaluate(data, p)
            best.append((r, repr(p), w))
        best.sort(key=lambda x: -x[0])
        print("\nGRID (top 12):")
        for r, desc, w in best[:12]:
            print(f"   {r}/{len(data)}  {desc}   wrong: {[ (d,t,l,pr) for d,t,l,pr in w ]}"[:400])
