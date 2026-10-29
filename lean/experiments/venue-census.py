"""Venue census: every confirmed named stay in the narratives against the
picker's candidates, replayed through `bestplace` from the fold's own naming
dumps. Run from the repo root with the decoder built:
    for f in tests/golden/days/*.json; do d=$(basename $f .json)
      mkdir -p <dumps>/$d; LEAN_DUMP_DIR=<dumps>/$d rust/target/release/backend day $f >/dev/null
    done
    python3 lean/experiments/venue-census.py <dumps>
Prints how often the true venue is the served label, the top summed total,
and the top total with the distance width re-widened; writes <dumps>/census.json
for the fits beside this script. Names only, never a coordinate."""
import json,glob,re,subprocess,datetime,math,sys,os,unicodedata
from zoneinfo import ZoneInfo
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); CLI=ROOT+'/lean/.lake/build/bin/verified_cli'
D=sys.argv[1] if len(sys.argv)>1 else '/tmp/pcensus'
SIGMAS=[6,8,10,12,16,20,30,40]
def norm(s): return unicodedata.normalize('NFKD',s or '').encode('ascii','ignore').decode().lower().strip()
# truth rows
truth={}
for f in sorted(glob.glob(ROOT+'/tests/golden/ground-truth/2026-*.md')):
    day=re.search(r'(\d{4}-\d\d-\d\d)',f).group(1); md=open(f).read()
    tzm=re.search(r'Times:\s*([A-Za-z_/]+)',md); tz=ZoneInfo(tzm.group(1) if tzm else 'Europe/London')
    y,m,d=map(int,day.split('-')); rows=[]
    for line in md.splitlines():
        mo=re.match(r'\|\s*(\d\d):(\d\d)\s*[–-]\s*(\d\d):(\d\d)\s*\|\s*stationary @ ([^|]+?)\s*\|\s*(\w+)',line)
        if not mo or mo.group(6)!='correct': continue
        a=datetime.datetime(y,m,d,int(mo.group(1)),int(mo.group(2)),tzinfo=tz).timestamp()
        b=datetime.datetime(y,m,d,int(mo.group(3)),int(mo.group(4)),tzinfo=tz).timestamp()
        if b<=a: b+=86400
        names=[norm(x) for x in mo.group(5).split('/')]
        rows.append((a,b,names,mo.group(5).strip()))
    truth[day]=rows
proc=subprocess.Popen([CLI,'serve'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
def ask(req):
    proc.stdin.write(json.dumps(req)+'\n'); proc.stdin.flush(); return json.loads(proc.stdout.readline())
out=[]
for dd in sorted(glob.glob(D+'/*/')):
    name=os.path.basename(dd.rstrip('/')); day=name[:10]
    for f in sorted(glob.glob(dd+'place-*.json')):
        req=json.load(open(f)); stay=req.get('stay') or {}
        if 'startUnix' not in stay: continue
        a,b=stay['startUnix'],stay['endUnix']
        best=None
        for (ta,tb,names,raw) in truth.get(day,[]):
            ov=max(0,min(b,tb)-max(a,ta))
            if ov>=0.5*(b-a) and ov>=0.5*(tb-ta): best=(names,raw)
        if not best: continue
        req['mode']='bestplace'; r=ask(req).get('result') or {}
        ranked=r.get('ranked') or []
        if not ranked: continue
        label=r.get('label')
        out.append({'day':day,'start':a,'end':b,'truth':best[1],'truthNames':best[0],'label':label,'ranked':ranked})
json.dump(out,open(D+'/census.json','w'))
def isTrue(c,names): return norm(c['name']) in names or any(n and n in norm(c['name']) for n in names)
n=len(out); print('named stays with candidates',n)
inlist=[o for o in out if any(isTrue(c,o['truthNames']) for c in o['ranked'])]
print('true venue among candidates',len(inlist))
print('served label right',sum(1 for o in inlist if o['label'] and norm(o['label']) in o['truthNames'] or (o['label'] and any(nn in norm(o['label']) for nn in o['truthNames'] if nn))))
def rightUnder(score):
    k=0
    for o in inlist:
        top=max(o['ranked'],key=score)
        k+= isTrue(top,o['truthNames'])
    return k
print('top by summed total',rightUnder(lambda c:c['total']))
for s in SIGMAS:
    sc=lambda c,s=s: c['total']+0.5*(c['distanceM']/40)**2-0.5*(c['distanceM']/s)**2
    print(f'top by total with distance sigma {s} m:',rightUnder(sc))
ds=sorted(min(c['distanceM'] for c in o['ranked'] if isTrue(c,o['truthNames'])) for o in inlist)
print('true venue distance quantiles (m): q25 %.0f q50 %.0f q75 %.0f q90 %.0f max %.0f'%(ds[len(ds)//4],ds[len(ds)//2],ds[3*len(ds)//4],ds[int(len(ds)*0.9)],ds[-1]))
for o in inlist:
    top=max(o['ranked'],key=lambda c:c['total']); lab=o['label']
    tv=[c for c in o['ranked'] if isTrue(c,o['truthNames'])][0]
    ok_lab= lab and (norm(lab) in o['truthNames'] or any(nn in norm(lab) for nn in o['truthNames'] if nn))
    if not ok_lab or not isTrue(top,o['truthNames']):
        print(o['day'],datetime.datetime.utcfromtimestamp(o['start']).strftime('%H:%MZ'),'truth',o['truth'][:28],'| label',lab,'| top total',top['name'],round(top['total'],2),top['subtype'],round(top['distanceM']),'m | true',tv['name'],round(tv['total'],2),tv['subtype'],round(tv['distanceM']),'m hours',tv['hours'])
