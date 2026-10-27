#!/usr/bin/env python3
"""Plan (and with `apply`) the platform-wait rows in the narratives.

A platform wait is read from the signal: the departure is the first fix faster
than 25 km/h and 150 m from the board station after the decoded ride's start,
the wait the still run before it (no minute of 50 steps, a fix within 120 m of
the station). Where a confirmed ride row covers the wait, the row starts at the
departure minute and a derived `stationary @ <station>` row precedes it; where
the ride already starts at the departure and the walk before it covers the
wait, the walk ends where the still run begins. Rows already preceded by a
stationary row, and rides whose row is not `correct`, are left alone.

    split-waits.py [apply] [<scratch-dir>]   # the scratch dir holds ride-time-fit.py's legs and requests
"""
import json, math, datetime, re, sys, os, collections, zoneinfo
UTC = datetime.timezone.utc
LON = zoneinfo.ZoneInfo('Europe/London')
SCR = sys.argv[2] if len(sys.argv) > 2 else '/Volumes/Backup/scratch/truth-debug'
GT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'tests/golden/ground-truth')
TODAY = datetime.date.today().isoformat()

def hav(a, b, c, d):
    R = 6371000; p1, p2 = math.radians(a), math.radians(c); dp = p2 - p1; dl = math.radians(d - b)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))

def census():
    legs = [json.loads(l) for l in open(f'{SCR}/ridetime-legs.jsonl')]
    reqs = {}; out = []
    for r in legs:
        d = r['day']
        if d not in reqs: reqs[d] = json.load(open(f'{SCR}/req-{d}.json'))
        req = reqs[d]; board = r['leg'].split('@')[1]
        pts = [tuple(map(float, n['id'].split(','))) for n in req['nodes'] if n.get('stationName') == board and ',' in n['id']]
        if not pts: continue
        fixes = sorted(req['observation']['points'], key=lambda f: f['ts']); steps = {s['ts']: s['steps'] for s in req['observation']['steps']}
        t0 = r['startTs']; near = lambda f: min(hav(f['lat'], f['lon'], la, lo) for la, lo in pts)
        dep = next((f for f in fixes if f['ts'] >= t0 - 120 and (f.get('speedKmh') or 0) > 25 and near(f) > 150), None)
        if not dep: continue
        depm = dep['ts'] // 60 * 60
        m = depm - 60; still = []
        while m > depm - 30 * 60:
            s = steps.get(m, 0)
            if s >= 50: break
            still.append((m, s)); m -= 60
        if len(still) < 2: continue
        still.reverse()
        fx = [f for f in fixes if still[0][0] <= f['ts'] < depm]
        nearest = min((near(f) for f in fx), default=None)
        if nearest is None or nearest > 120: continue
        out.append({'day': d, 'board': board, 'w': still[0][0], 'dep': depm, 'depFix': dep['ts'], 'steps': [s for _, s in still], 'nearest': round(nearest), 'legStart': t0})
    return out

ROW = re.compile(r'^\| *(\d\d:\d\d) *[–-] *(\d\d:\d\d) *\| *([^|]*?) *\| *([^|]*?) *\|(.*)$')

def local(ts, tz):
    return datetime.datetime.fromtimestamp(ts, UTC).astimezone(tz)

def plan(apply=False):
    waits = census()
    by_day = collections.defaultdict(list)
    for w in waits: by_day[w['day']].append(w)
    n_done = n_skip = 0
    for day in sorted(by_day):
        p = f'{GT}/{day}.md'
        if not os.path.exists(p): print(f'{day}: no narrative ({len(by_day[day])} waits)'); n_skip += len(by_day[day]); continue
        lines = open(p).read().split('\n')
        tz = LON
        for l in lines:
            if l.startswith('Times:'): tz = UTC if 'UTC' in l else zoneinfo.ZoneInfo(l.split(':', 1)[1].strip())
        if not lines[0].startswith(f'# {day}'): print(f'{day}: unexpected header: {lines[0][:60]}')
        edits = []
        for w in sorted(by_day[day], key=lambda w: w['w']):
            W = local(w['w'], tz).strftime('%H:%M'); D = local(w['dep'], tz).strftime('%H:%M'); L = local(w['legStart'], tz).strftime('%H:%M')
            cand = None
            for i, l in enumerate(lines):
                m = ROW.match(l)
                if not m: continue
                s, e, what, status = m.group(1), m.group(2), m.group(3), m.group(4)
                if not what.startswith('train'): continue
                if not (W <= s <= D or s == L or (s <= W and e > D)): continue
                cand = (i, s, e, what, status); break
            if cand is None: print(f'  {day} {w["board"]} wait {W}–{D}: no ride row found (leg {L})'); n_skip += 1; continue
            i, s, e, what, status = cand
            if not status.startswith('correct'): print(f'  {day} {w["board"]} wait {W}–{D}: ride row is {status!r}, skipped'); n_skip += 1; continue
            if w['board'].split()[0].lower() not in what.lower(): print(f'  {day} {w["board"]} wait {W}–{D}: ride row names another board: {what[:50]!r}, skipped'); n_skip += 1; continue
            prev = ROW.match(lines[i - 1]) if i > 0 else None
            if s >= D:
                # The ride already starts at the departure: the wait sits at the end of the walk before it.
                if prev and prev.group(3).startswith('walking') and prev.group(2) == s and prev.group(1) < W and prev.group(4).startswith('correct'):
                    edits.append((i, s, e, what, status, W, s, w, prev)); continue
                print(f'  {day} {w["board"]} wait {W}–{D}: ride row already starts at {s} ≥ departure, before it {prev.group(3)[:30] if prev else None!r} {prev.group(1) if prev else ""}–{prev.group(2) if prev else ""}, skipped'); n_skip += 1; continue
            if prev and prev.group(3).startswith('stationary') and prev.group(2) >= W: print(f'  {day} {w["board"]} wait {W}–{D}: a stationary row already precedes ({prev.group(1)}–{prev.group(2)}), skipped'); n_skip += 1; continue
            edits.append((i, s, e, what, status, W, D, w, prev))
        if not edits: continue
        print(f'{day}: {len(edits)} wait(s)')
        for i, s, e, what, status, W, D, w, prev in sorted(edits, key=lambda x: -x[0]):
            sep = ' – ' if ' – ' in lines[i] else '–'
            # The wait begins where the row before ends, unless that row is the walk whose end moves.
            if prev and prev.group(2) > W and not (prev.group(3).startswith('walking') and prev.group(2) == s and prev.group(4).startswith('correct')):
                print(f'   wait start {W} clamped to {prev.group(2)} ({prev.group(3)[:30]!r} ends there)'); W = prev.group(2)
            if W >= D: print('   nothing left of the wait, skipped'); continue
            name = w['board']
            if name == "King's Cross St Pancras": name = "King's Cross St Pancras / London King's Cross"
            st = w['steps']; still_min = sum(1 for x in st if x == 0)
            stepnote = 'no steps' if max(st) == 0 else f'{still_min} of {len(st)} minutes without a step, the rest under {max(st)}'
            note = f'the platform wait: {stepnote}, the fixes within {w["nearest"]} m of the station; the train pulls away {local(w["depFix"], tz).strftime("%H:%M:%S")} ({TODAY}, split from the ride below)'
            new_ride = lines[i] if s == D else (lines[i].replace(f'| {s}', f'| {D}', 1) if lines[i].startswith(f'| {s}') else lines[i].replace(f'|{s}', f'|{D}', 1))
            wait_row = f'| {W}{sep}{D} | stationary @ {name} | correct {{derived}} | {note} |'
            print(f'   ride {s}→{D} {what[:45]!r}; wait {W}–{D} {w["board"]} steps {st}')
            if prev and prev.group(3).startswith('walking') and prev.group(2) == s and W < s and prev.group(4).startswith('correct'):
                print(f'   walk row {prev.group(1)}–{prev.group(2)} ends at {W}')
                if apply: lines[i - 1] = lines[i - 1].replace(f'{sep}{s} |', f'{sep}{W} |', 1) if f'{sep}{s} |' in lines[i - 1] else lines[i - 1]
            if apply:
                lines[i] = new_ride; lines.insert(i, wait_row)
            n_done += 1
        if apply: open(p, 'w').write('\n'.join(lines))
    print(f'planned {n_done}, skipped {n_skip}')

plan(apply=len(sys.argv) > 1 and sys.argv[1] == 'apply')
