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
            # The same window is ranked more than once (a re-resolution later in the
            # fold); the LAST ranking is the one the served state carries. Keeping the
            # first (until 2026-09-29) made 06-28 read as right when the pod said otherwise.
            if key in seen:
                stays[stays.index(seen[key])] = j; seen[key] = j; continue
            seen[key] = j; stays.append(j); continue
        i = l.find('VENUETOP ')
        if i >= 0:
            j = json.loads(l[i+9:].strip())
            st = seen.get((j['s'], j['e']))
            if st is not None: st['top'] = j
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
                 dwell_lo=-2.0, dwell_hi=1.2, hour_lo=-1.5, hour_hi=1.2, near=12.0, floor=-1.5, nf_min=0.0,
                 pseudo=None, global_pool=False, footprint=0.0, short_neutral=False):
        self.__dict__.update(locals()); del self.__dict__['self']
    def __repr__(self):
        return f"σ={self.sigma:g} open={self.open_:g} base=[{self.base_lo:g},{self.base_hi:g}] near={self.near:g} nf_min={self.nf_min:g} venue={self.venue:g} pseudo={self.pseudo} global={self.global_pool} footprint={self.footprint:g}"

def clamp(x, lo, hi): return min(hi, max(lo, x))

_DAY = {}
def day_info(stay):
    """(global pool, name->isPoint) for the stay's day, from its fixture."""
    d = date_of(stay['s'])
    if d not in _DAY:
        import glob as _g
        paths = _g.glob(f"{os.path.dirname(__file__)}/../../tests/golden/days/{d}-*.json")
        if not paths: _DAY[d] = (None, {}); return _DAY[d]
        fx = json.load(open(paths[0]))
        blob = fx['inputs'].get('venuePriors') or {}
        n = 0.0; hours = [0.0]*24; dwell = [0.0]*4
        for v in (blob.get('byCategory') or {}).values():
            n += v['visits']; hours = [a+b for a,b in zip(hours, v['hours'])]; dwell = [a+b for a,b in zip(dwell, v['dwell'])]
        pts = {}
        for r in fx['inputs']['osmRowSet']['points']:
            if r.get('name'): pts.setdefault(norm(r['name']), True)
        for r in fx['inputs']['osmRowSet']['lines']:
            if r.get('name'): pts[norm(r['name'])] = pts.get(norm(r['name']), False) and False
        _DAY[d] = ({'n': n, 'hours': hours, 'dwell': dwell}, pts)
    return _DAY[d]

DWELL_BOUNDS = [10, 40, 150]
def dwell_bucket(sec):
    m = sec / 60
    for i, b in enumerate(DWELL_BOUNDS):
        if m < b: return i
    return len(DWELL_BOUNDS)

def pooled(mass, n, pseudo, dims):
    """blendedBinP with only a pool and the uniform pseudo-count: log-ratio against uniform."""
    u = 1.0 / dims
    return math.log(((mass + pseudo * u) / (n + pseudo)) * dims)

def rank(stay, p):
    cands = []
    gpool, is_point = day_info(stay) if (p.global_pool or p.footprint or p.short_neutral) else (None, {})
    for c in stay['c']:
        isv = c['t'] in VENUE_TYPES
        d_eff = c['d']
        if p.footprint and is_point.get(norm(c['n']), False):
            d_eff = max(0.0, c['d'] - p.footprint)
        dist = -0.5 * (d_eff / p.sigma) ** 2
        venue = p.venue if isv else 0.0
        shape = None
        if c['t'] in PRIOR_TYPES and not (c['b'] == 0 and c['dw'] == 0 and c['hr'] == 0):
            b = c['b']
            # BASE_RATE_PSEUDO swept offline: the trace carries the subtype's visits `sv`,
            # the blob's `tv` and `k`, so the base log-ratio can be recomputed for any pseudo-count.
            if p.pseudo is not None and 'sv' in c:
                b = math.log((c['sv'] + p.pseudo) / (c['tv'] + p.pseudo * c['k']) * c['k'])
            dw, hr = c['dw'], c['hr']
            # A stay in a dwell bucket the mined pool has NEVER filled says nothing about the
            # venue's kind: the miner attributes no visit that short, so every candidate's dwell
            # term is the same artefact. Neutral for all.
            if p.short_neutral and gpool and gpool['dwell'][dwell_bucket(stay['e'] - stay['s'])] == 0:
                dw = 0.0
            # An unseen subtype with no category pool reads 0 for dwell and hour — "no evidence" —
            # while a visited one carries its (negative) profile. The global-pool arm backs such a
            # candidate off to ALL his visits instead of to uniform.
            if p.global_pool and gpool and c.get('sv', 0) == 0 and dw == 0 and hr == 0 and gpool['n'] > 0:
                dw = pooled(gpool['dwell'][dwell_bucket(stay['e'] - stay['s'])], gpool['n'], 4.0, 4)
                hr = pooled(gpool['hours'][stay['h'] % 24], gpool['n'], 8.0, 24)
            shape = clamp(b, p.base_lo, p.base_hi) + clamp(dw, p.dwell_lo, p.dwell_hi) + clamp(hr, p.hour_lo, p.hour_hi)
        hours = None
        if c['of'] is not None:
            hours = p.closed + c['of'] * (p.open_ - p.closed)
        total = dist + venue + (shape or 0.0) + (hours or 0.0)
        # NEAR_FIELD_MIN_NATS (2026-09-28): the veto goes only to a candidate whose own total is at least neutral.
        nf = isv and not c['rg'] and d_eff <= p.near and (hours is None or hours >= 0) and total >= p.nf_min
        cands.append(dict(c, total=total, nf=nf, d_eff=d_eff))
    def key(c):
        return (0 if c['enc'] else 1, 0 if c['nf'] else 1, c['d_eff'] if c['nf'] else 0.0, -c['total'], c['d_eff'], c['n'].lower())
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
    if len(sys.argv) > 1 and sys.argv[1] == 'short':
        for sn in (False, True):
            r, w = evaluate(data, P(pseudo=2, short_neutral=sn))
            print(f"   short_neutral={sn}: {r}/{len(data)}   wrong: {[(d,t,l,pr) for d,t,l,pr in w]}"[:420])
    if len(sys.argv) > 1 and sys.argv[1] == 'dense':
        best = []
        for gp, fp in itertools.product([False, True], [0, 4, 6, 8, 12]):
            p = P(pseudo=2, global_pool=gp, footprint=fp)
            r, w = evaluate(data, p)
            best.append((r, f"global_pool={gp} footprint={fp:g}", w))
        best.sort(key=lambda x: -x[0])
        print("\nDENSE GRID:")
        for r, desc, w in best:
            print(f"   {r}/{len(data)}  {desc}   wrong: {[(d,t,l,pr) for d,t,l,pr in w]}"[:420])
    if len(sys.argv) > 1 and sys.argv[1] == 'show':
        # show <YYYY-MM-DD> <HH:MM>Z: the ranked candidates for one stay under the shipped constants.
        want_d, want_t = sys.argv[2], sys.argv[3]
        p = P(pseudo=2, global_pool=bool(os.environ.get('FIT_GLOBAL')), footprint=float(os.environ.get('FIT_FOOTPRINT', 0)))
        for st in stays:
            if date_of(st['s']) != want_d or time.strftime('%H:%M', time.gmtime(st['s'])) != want_t: continue
            r = rank(st, p)
            gp, _ = day_info(st)
            print(f"{want_d} {want_t}Z–{time.strftime('%H:%M', time.gmtime(st['e']))}Z h={st['h']} dur={st['e']-st['s']}s bucket={dwell_bucket(st['e']-st['s'])} pool={gp and (gp['n'], gp['hours'][st['h']%24], gp['dwell'][dwell_bucket(st['e']-st['s'])])}")
            for c in r[:10]:
                dist = -0.5 * (c['d'] / p.sigma) ** 2
                b = math.log((c['sv'] + p.pseudo) / (c['tv'] + p.pseudo * c['k']) * c['k']) if 'sv' in c else c['b']
                print(f"   {'NF' if c['nf'] else '  '} {'ENC' if c['enc'] else '   '} {c['n'][:26]:26} {c['st'][:14]:14} d={c['d']:5.1f} tot={c['total']:6.2f}  dist={dist:5.2f} b={clamp(b,p.base_lo,p.base_hi):5.2f} dw(trace)={c['dw']:5.2f} hr(trace)={c['hr']:5.2f} of={c['of']} sv={c.get('sv')}")
    if len(sys.argv) > 1 and sys.argv[1] == 'pseudo':
        best = []
        for pseudo, base_lo in itertools.product([0.5, 1, 2, 4, 8, 16], [-2, -1.5, -1, -0.5]):
            p = P(pseudo=pseudo, base_lo=base_lo)
            r, w = evaluate(data, p)
            best.append((r, f"pseudo={pseudo:g} base_lo={base_lo:g}", w))
        best.sort(key=lambda x: -x[0])
        print("\nPSEUDO GRID (top 10):")
        for r, desc, w in best[:10]:
            print(f"   {r}/{len(data)}  {desc}   wrong: {[(d,t,l,pr) for d,t,l,pr in w]}"[:420])
    if len(sys.argv) > 1 and sys.argv[1] == 'shape':
        best = []
        for hour_lo, dwell_lo, base_lo, nf_min in itertools.product([-1.5, -1.0, -0.5, 0], [-2, -1, -0.5, 0], [-2, -1, -0.5], [0, -0.5]):
            p = P(hour_lo=hour_lo, dwell_lo=dwell_lo, base_lo=base_lo, nf_min=nf_min)
            r, w = evaluate(data, p)
            best.append((r, f"hour_lo={hour_lo:g} dwell_lo={dwell_lo:g} base_lo={base_lo:g} nf_min={nf_min:g}", w))
        best.sort(key=lambda x: -x[0])
        print("\nSHAPE GRID (top 10):")
        for r, desc, w in best[:10]:
            print(f"   {r}/{len(data)}  {desc}   wrong: {[(d,t,l,pr) for d,t,l,pr in w]}"[:420])
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
