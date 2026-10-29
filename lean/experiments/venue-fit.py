"""Conditional-logit fit of the venue picker's terms over the census stays
(pcensus-all/census.json, with per-candidate parts). Forms:
  current : the shipped sum (distance sigma 40, clamps, venue 1.5, hours 0.7/-2.5)
  sigma   : the shipped sum with the distance width refit alone
  full    : sigma, venue weight, hours open/closed, and weights on the three
            unclamped shape log-ratios (base, dwell, hour)
Each form is scored in-sample and leave-one-stay-out: how many of the stays
put the true venue first (enclosing candidates first, as the picker does)."""
import json,math,unicodedata,numpy as np
from scipy.optimize import minimize
import sys
o=json.load(open(sys.argv[1] if len(sys.argv)>1 else '/tmp/pcensus/census.json'))
def norm(s): return unicodedata.normalize('NFKD',s or '').encode('ascii','ignore').decode().lower().strip()
def isTrue(c,names): return norm(c['name']) in names or any(n and n in norm(c['name']) for n in names)
stays=[]
for s in o:
    cands=s['ranked']; t=[i for i,c in enumerate(cands) if isTrue(c,s['truthNames'])]
    if not t: continue
    rows=[]
    for c in cands:
        sp=c.get('shapeParts') or [0,0,0]
        rows.append([c['distanceM'], 1.0 if c['venue']>0 else 0.0,
                     c['openFraction'] if c.get('openFraction') is not None else np.nan,
                     sp[0],sp[1],sp[2], 1.0 if c['enclosing'] else 0.0, 1.0 if c.get('shape') is not None else 0.0])
    stays.append((np.array(rows,dtype=float), t[0], s))
print('stays',len(stays))
def clamp(x,lo,hi): return np.minimum(np.maximum(x,lo),hi)
def score(X,p,form):
    d,v,frac,b,dw,h,enc,hasShape=X.T
    if form=='current' or form=='sigma':
        sig=p[0]
        hours=np.where(np.isnan(frac),0,-2.5+np.nan_to_num(frac)*(0.7+2.5))
        shape=hasShape*(clamp(b,-2,1.5)+clamp(dw,-2,1.2)+clamp(h,-1.5,1.2))
        return -0.5*(d/sig)**2+1.5*v+shape+hours
    sig,wv,ho,hc,wb,wd,wh=p
    hours=np.where(np.isnan(frac),0,hc+np.nan_to_num(frac)*(ho-hc))
    return -0.5*(d/sig)**2+wv*v+hasShape*(wb*b+wd*dw+wh*h)+hours
def nll(p,form,idx):
    tot=0.0
    for i in idx:
        X,t,_=stays[i]; s=score(X,p,form); m=s.max(); tot-= s[t]-m-math.log(np.exp(s-m).sum())
    return tot
def fit(form,idx):
    if form=='current': return np.array([40.0])
    if form=='sigma':
        r=minimize(lambda q: nll([math.exp(q[0])],form,idx),[math.log(10)],method='Nelder-Mead'); return np.array([math.exp(r.x[0])])
    x0=[math.log(10),1.5,0.7,-2.5,1,1,1]
    f=lambda q: nll([math.exp(q[0])]+list(q[1:]),form,idx)+0.01*float(np.sum(np.square(q[1:])))
    r=minimize(f,x0,method='Nelder-Mead',options={'maxiter':20000,'xatol':1e-4,'fatol':1e-6})
    return np.array([math.exp(r.x[0])]+list(r.x[1:]))
def right(p,form,idx):
    k=0
    for i in idx:
        X,t,_=stays[i]; s=score(X,p,form); s=s+1e6*X[:,6]; k+= int(np.argmax(s)==t)
    return k
n=len(stays); allidx=list(range(n))
for form in ('current','sigma','full'):
    p=fit(form,allidx)
    loo=0; losers=[]
    for i in allidx:
        pi=fit(form,[j for j in allidx if j!=i]); ok=right(pi,form,[i]); loo+=ok
        if not ok: X,t,s=stays[i]; sc=score(X,pi,form)+1e6*X[:,6]; w=s['ranked'][int(np.argmax(sc))]; losers.append((s['day'],s['truth'][:16],w['name'][:18],round(w['distanceM'])))
    print(f"{form:8s} params {np.round(p,2)}  in-sample right {right(p,form,allidx)}/{n}  leave-one-out right {loo}/{n}  nll {nll(p,form,allidx):.1f}")
    print('   LOO losers:',losers)
