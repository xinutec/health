"""Width and outside-option constant fitted jointly on all census stays: the 55
whose true venue is a candidate (choice = that candidate) and the 30 whose is
not (choice = outside). Enclosing first as the picker does. Leave-one-out."""
import json,math,unicodedata,numpy as np
from scipy.optimize import minimize
import sys
o=json.load(open(sys.argv[1] if len(sys.argv)>1 else '/tmp/pcensus/census.json'))
def norm(s): return unicodedata.normalize('NFKD',s or '').encode('ascii','ignore').decode().lower().strip()
def isTrue(c,names): return norm(c['name']) in names or any(n and n in norm(c['name']) for n in names)
def clamp(x,lo,hi): return np.minimum(np.maximum(x,lo),hi)
stays=[]
for s in o:
    cands=s['ranked']; t=[i for i,c in enumerate(cands) if isTrue(c,s['truthNames'])]
    rows=[]
    for c in cands:
        sp=c.get('shapeParts') or [0,0,0]
        rows.append([c['distanceM'],1.0 if c['venue']>0 else 0.0,c['openFraction'] if c.get('openFraction') is not None else np.nan,sp[0],sp[1],sp[2],1.0 if c['enclosing'] else 0.0,1.0 if c.get('shape') is not None else 0.0])
    stays.append((np.array(rows,dtype=float), t[0] if t else -1, s))
print('stays',len(stays),'inside',sum(1 for x in stays if x[1]>=0),'outside',sum(1 for x in stays if x[1]<0))
def score(X,sig):
    d,v,frac,b,dw,h,enc,hasShape=X.T
    hours=np.where(np.isnan(frac),0,-2.5+np.nan_to_num(frac)*3.2)
    shape=hasShape*(clamp(b,-2,1.5)+clamp(dw,-2,1.2)+clamp(h,-1.5,1.2))
    return -0.5*(d/sig)**2+1.5*v+shape+hours
def nll(p,idx):
    sig,c=p; tot=0.0
    for i in idx:
        X,t,_=stays[i]; s=np.append(score(X,sig),c); m=s.max()
        tot-= s[t if t>=0 else -1]-m-math.log(np.exp(s-m).sum())
    return tot
def fit(idx):
    r=minimize(lambda q: nll([math.exp(q[0]),q[1]],idx),[math.log(10),-1.5],method='Nelder-Mead'); return [math.exp(r.x[0]),r.x[1]]
def decide(X,t,sig,c):
    s=score(X,sig); top=int(np.argmax(s+1e6*X[:,6])) if X[:,6].any() else int(np.argmax(s))
    # the picker: enclosing first; else the top candidate if above the floor, else outside
    if X[:,6].any(): return top==t
    return (top==t) if s[top]>=c else (t<0)
def evaluate(sig,c,idx):
    ins=sum(decide(*stays[i][:2],sig,c) for i in idx if stays[i][1]>=0); outs=sum(decide(*stays[i][:2],sig,c) for i in idx if stays[i][1]<0); return ins,outs
n=len(stays); allidx=list(range(n))
print('current (40, -1.5): inside right %d/55, outside right %d/30'%evaluate(40,-1.5,allidx),' nll %.1f'%nll([40,-1.5],allidx))
p=fit(allidx); print('fitted width %.1f m, outside constant %.2f nats; in-sample inside %d/55 outside %d/30; nll %.1f'%(p[0],p[1],*evaluate(p[0],p[1],allidx),nll(p,allidx)))
li=lo=0; losers=[]
for i in allidx:
    pi=fit([j for j in allidx if j!=i]); ok=decide(*stays[i][:2],pi[0],pi[1])
    if stays[i][1]>=0: li+=ok
    else: lo+=ok
    if not ok: losers.append((stays[i][2]['day'],stays[i][2]['truth'][:16],'in' if stays[i][1]>=0 else 'out'))
print('leave-one-out: inside %d/55 outside %d/30'%(li,lo)); print('LOO losers',losers)
for sig in (11,14,18):
    r=minimize(lambda q: nll([sig,q[0]],allidx),[-1.5],method='Nelder-Mead'); c=r.x[0]
    print('width %d fixed: outside constant %.2f; inside %d/55 outside %d/30'%(sig,c,*evaluate(sig,c,allidx)))
