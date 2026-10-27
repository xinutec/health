#!/usr/bin/env python3
"""Fit the ride-time law to the rides the journey decodes across the frozen corpus.

The law prices a pair's ride: along-track km at `RIDE_RUN_KMH`, `RIDE_STOP_MIN`
per intermediate call, `RIDE_FIXED_MIN` once (and the flat `TUBE_SPEED_KMH` +
`STOP_OVERHEAD_MIN` where the calls are unknown); the density around it is a
Gaussian of width `Journey.RIDE_SIGMA_MIN`. The population is the decoded
station legs themselves — the leg lengths the density is applied to — read
from the journey debugger (`pathM`, `calls`, `expectedMin`, `d` per leg).

    ride-time-fit.py collect <scratch-dir>   # dump each day's request, serve, write legs.jsonl
    ride-time-fit.py fit <scratch-dir>       # least squares + width by likelihood

Run from the repo root with the decoder built (`lake build verified_cli`).
"""
import glob, json, math, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLI = f'{ROOT}/lean/.lake/build/bin/verified_cli'


def collect(scr):
    out_path = f'{scr}/ride-time-legs.jsonl'
    days = sorted(os.path.basename(p)[:-5] for p in glob.glob(f'{ROOT}/tests/golden/decoded_days/*.json'))
    with open(out_path, 'w') as out:
        for name in days:
            reqp = f'{scr}/req-{name[:10]}.json'
            if not os.path.exists(reqp):
                r = subprocess.run(['../scripts/dev', 'cargo', 'run', '--release', '--example', 'dump_decode_request', '--', name],
                                   cwd=f'{ROOT}/rust', capture_output=True, text=True)
                if r.returncode != 0:
                    print(name, 'dump failed', r.stderr[-300:], file=sys.stderr)
                    continue
                open(reqp, 'w').write(r.stdout)
            req = json.load(open(reqp))
            req['mode'] = 'assemblesegments'
            req['journeyDebug'] = {'alt': []}
            r = subprocess.run([CLI, 'serve'], input=json.dumps(req), capture_output=True, text=True)
            try:
                res = json.loads(r.stdout.strip().splitlines()[-1])['result']
            except Exception as e:
                print(name, 'serve failed', e, r.stderr[-300:], file=sys.stderr)
                continue
            n = 0
            for j in res.get('journeys', []):
                for leg in j['decoded']['legs']:
                    if leg.get('alight') is None or leg.get('expectedMin') is None or leg.get('pathM') is None:
                        continue
                    out.write(json.dumps({'day': name[:10], 'leg': leg['leg'], 'alight': leg['alight'], 'd': leg['d'],
                                          'expectedMin': leg['expectedMin'], 'pathM': leg['pathM'],
                                          'calls': leg.get('calls'), 'startTs': leg['startTs']}) + '\n')
                    n += 1
            print(name, n, 'paired legs')


def lstsq(X, y):
    n = len(X[0])
    A = [[sum(x[i] * x[j] for x in X) for j in range(n)] for i in range(n)]
    b = [sum(x[i] * yy for x, yy in zip(X, y)) for i in range(n)]
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(A[r][i]))
        A[i], A[p] = A[p], A[i]
        b[i], b[p] = b[p], b[i]
        for r in range(n):
            if r == i:
                continue
            f = A[r][i] / A[i][i]
            for c in range(i, n):
                A[r][c] -= f * A[i][c]
            b[r] -= f * b[i]
    return [b[i] / A[i][i] for i in range(n)]


def width(res, exp):
    n = len(res)
    print(f'  n={n} mean residual {sum(res)/n:+.2f} rms {math.sqrt(sum(x*x for x in res)/n):.2f} min')

    def ll(sig):
        return sum(-0.5 * math.log(2 * math.pi) - math.log(s) - 0.5 * (r / s) ** 2 for r, s in zip(res, sig))
    best = max((ll([sc] * n), sc) for sc in [x / 10 for x in range(5, 60)])
    print(f'  constant width: {best[1]:.1f} min  ll {best[0]:.1f}')
    best = max((ll([max(0.01, fr * e) for e in exp]), fr) for fr in [x / 100 for x in range(2, 60)])
    print(f'  proportional width: {best[1]:.2f} * expected  ll {best[0]:.1f}')
    best = max((ll([max(fl, fr * e) for e in exp]), fl, fr)
               for fl in [x / 10 for x in range(2, 40)] for fr in [x / 100 for x in range(2, 60)])
    print(f'  floor + fraction: max({best[1]:.1f}, {best[2]:.2f} * expected)  ll {best[0]:.1f}')


def fit(scr):
    rows = [json.loads(l) for l in open(f'{scr}/ride-time-legs.jsonl')]
    withc = [r for r in rows if r['calls'] is not None]
    print(f'{len(rows)} paired legs, {len(withc)} with calls known')
    X = [[r['pathM'] / 1000, r['calls'], 1] for r in withc]
    y = [r['d'] for r in withc]
    k = lstsq(X, y)
    print(f'with calls: RIDE_RUN_KMH {60/k[0]:.1f}  RIDE_STOP_MIN {k[1]:.2f}  RIDE_FIXED_MIN {k[2]:.2f}')
    exp = [sum(a * b for a, b in zip(x, k)) for x in X]
    width([yy - e for yy, e in zip(y, exp)], exp)
    X2 = [[r['pathM'] / 1000, 1] for r in rows]
    y2 = [r['d'] for r in rows]
    k2 = lstsq(X2, y2)
    print(f'no calls:   TUBE_SPEED_KMH {60/k2[0]:.1f}  STOP_OVERHEAD_MIN {k2[1]:.2f}')
    exp2 = [sum(a * b for a, b in zip(x, k2)) for x in X2]
    width([yy - e for yy, e in zip(y2, exp2)], exp2)
    resc = [r['d'] - r['expectedMin'] for r in rows]
    print(f'the law as built: mean residual {sum(resc)/len(resc):+.2f} min, rms {math.sqrt(sum(x*x for x in resc)/len(resc)):.2f}')


if __name__ == '__main__':
    {'collect': collect, 'fit': fit}[sys.argv[1]](sys.argv[2])
