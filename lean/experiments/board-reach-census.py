"""Of the narrated rides with a board station, how many begin within the
journey's reach (400 m) of a node of that station, by the decoder's own
notion of a minute's fix: the minute's own point, else the last point carried
from the ten minutes before. The population behind the plain line leg's
share (a ride whose board the fixes do not reach) and the reach rule itself.
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
        if g: fix=(g['lat'],g['lon'])
        tot+=1
        if fix is None: rows.append((day,mo.group(1)+':'+mo.group(2),board,'dark')); continue
        dmin=min(hav(fix[0],fix[1],la,lo) for la,lo in cands)
        ok=dmin<=400; near+=ok; rows.append((day,mo.group(1)+':'+mo.group(2),board,int(dmin)))
print('rides with a board station',tot,'first fix within 400 m',near,'dark',sum(1 for r in rows if r[3]=='dark'),'no node',sum(1 for r in rows if r[3]=='no node'))
far=[r for r in rows if isinstance(r[3],int) and r[3]>400]; print('far (>400 m):',far)
print('dark:',[r[:3] for r in rows if r[3]=='dark'][:20])
