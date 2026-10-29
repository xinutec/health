"""Of the narrated rides with a board station, how many begin within the
journey's reach (400 m) of a node of that station, read from the FIRST point
of the row's first minute (else the last point carried from the ten minutes
before). A departing minute's first point lies where the train already is,
so this reads the row's grain as much as the rule: the decoder's own start
rule begins a station leg at the platform minute before. The honest census
of the rule is the journey debugger's `reach` per forced leg.
Run from the repo root: python3 lean/experiments/board-reach-census.py <dir of req-<date>.json dumps>
(dump_decode_request writes them). Names and distances only."""
import json,re,glob,math,datetime,sys,os
from zoneinfo import ZoneInfo
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); REQ=sys.argv[1] if len(sys.argv)>1 else '/tmp/req'
def hav(a,b,c,d):
    p=math.pi/180; x=(c-a)*p; y=(d-b)*p*math.cos((a+c)/2*p); return 6371000*math.hypot(x,y)
tot=near=0; rows=[]
for f in sorted(glob.glob(ROOT+'/tests/golden/ground-truth/2026-*.md')):
    day=re.search(r'(\d{4}-\d\d-\d\d)',f).group(1); md=open(f).read()
    try: req=json.load(open(f'{REQ}/req-{day}.json'))
    except FileNotFoundError: continue
    tzm=re.search(r'Times:\s*([A-Za-z_/]+)',md); hdr=re.search(r'\((UTC|Europe/[A-Za-z]+)\)',md.splitlines()[0])
    tz=ZoneInfo(tzm.group(1) if tzm else (hdr.group(1) if hdr else 'Europe/London'))
    y,m,d=map(int,day.split('-'))
    nodes=[(n.get('stationName') or '',)+tuple(map(float,n['id'].split(','))) for n in req['nodes'] if n.get('stationName')]
    pts=req['observation']['points']
    for line in md.splitlines():
        mo=re.match(r'\|\s*(\d\d):(\d\d)\s*[–-]\s*(\d\d):(\d\d)\s*\|\s*train\s+([^→|·]+?)\s*→\s*([^|·(]+?)\s*(?:·|\(|\|)',line)
        if not mo or '| correct' not in line: continue
        a=datetime.datetime(y,m,d,int(mo.group(1)),int(mo.group(2)),tzinfo=tz).timestamp()
        board=mo.group(5).strip().strip('*')
        cands=[(la,lo) for nm,la,lo in nodes if nm.lower().startswith(board.lower()[:10]) or board.lower()[:10] in nm.lower()]
        if not cands: rows.append((day,mo.group(1)+':'+mo.group(2),board,'no node')); continue
        fix=None
        # the decoder's reach: the minute's own fix, else the last fix carried from before (the stale window)
        own=[g for g in pts if a<=g['ts']<a+60]
        before=[g for g in pts if a-600<=g['ts']<a]
        g=own[0] if own else (before[-1] if before else None)
        if g: fix=(g['lat'],g['lon']); age=int((a-g['ts'])//60); acc=g.get('accuracyM')
        tot+=1
        if fix is None: rows.append((day,mo.group(1)+':'+mo.group(2),board,'dark')); continue
        dmin=min(hav(fix[0],fix[1],la,lo) for la,lo in cands)
        ok=dmin<=400; near+=ok; rows.append((day,mo.group(1)+':'+mo.group(2),board,int(dmin),age,acc))
print('rides with a board station',tot,'first fix within 400 m',near,'dark',sum(1 for r in rows if r[3]=='dark'),'no node',sum(1 for r in rows if r[3]=='no node'))
far=[r for r in rows if isinstance(r[3],int) and r[3]>400]
print('far (>400 m): day start board distM ageMin accM, and distance − 77 m/min × age:')
for r in far: print('  ',r[0],r[1],r[2][:14].ljust(14),'d',r[3],'age',r[4],'acc',r[5],'slack',int(r[3]-77*max(r[4],0)))
ok=[r for r in rows if isinstance(r[3],int) and r[3]<=400]
import statistics
print('near: distance q50/q90',statistics.median([r[3] for r in ok]),sorted(r[3] for r in ok)[int(0.9*len(ok))],'age q50/q90',statistics.median([r[4] for r in ok]),sorted(r[4] for r in ok)[int(0.9*len(ok))])
print('under the kinematic bound d <= acc + 77*age + 200:',sum(1 for r in rows if isinstance(r[3],int) and r[3]<= (r[5] or 0)+77*max(r[4],0)+200),'of',sum(1 for r in rows if isinstance(r[3],int)))
print('dark:',[r[:3] for r in rows if r[3]=='dark'][:20])
