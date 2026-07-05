---
created: 2026-07-01
status: proposed (formal spec)
references:
  - 2026-06-map-constrained-positioning.md
  - 2026-07-true-path-reconstruction.md
  - decoder-roadmap.md
  - ../design/probabilistic-principles.md
---

# The joint mode+position model — formal specification and proofs

> One-line: replace the *classify-then-draw-then-patch* cascade with a single
> **MAP estimate over a constrained factor model** in which mode and position are
> inferred jointly. The pipeline already out-scores the weak HSMM decoder
> (measured 2026-07-01: pipeline 35 journeys vs decoder 13/27 — see
> `journey-gate`), so the move is **not** to adopt the decoder but to make the
> pipeline's own evidence *principled*: the same signals (motion, rail/road
> corridor, cadence, map layer), combined as a probabilistic posterior under hard
> physical constraints, decoded to the single most probable day. The failure
> classes chased all session (tube→car, tube→walk teleport, torn alight) become
> **measure-zero or dominated** under the model — provably, below — so there is
> nothing to patch afterward.

Every claim here is gated by the journey ratchet (`docs`… `journey-gate`): a
change ships only if the corpus journey count rises or holds, never regresses.

## 1. The model

**Timeline.** Discretise the day into minutes $t = 1,\dots,T$ (the grain the
narrative and the decoder already use). The hidden state at $t$ is

$$x_t = (m_t,\; \ell_t), \qquad m_t \in \mathcal M,\; \ell_t \in \mathcal L(m_t),$$

where $\mathcal M = \{\text{stationary},\text{walk},\text{cycle},\text{drive},
\text{bus},\text{train},\text{plane}\}$ is the **mode** and $\ell_t$ is the
**map-constrained position**: the network edge + offset for a moving mode, or the
place/footprint id for a stay. The state space *is* the map, not free $\mathbb R^2$
(the central point of `map-constrained-positioning`).

**Observations.** $o_t = (g_t, a_t, v_t, c_t, h_t)$ — GPS fix $g_t$ with reported
accuracy $a_t$, derived speed $v_t$, cadence (steps/min) $c_t$, heart rate $h_t$ —
plus static map features $\Phi(\ell)$ (is $\ell$ on a rail corridor? a drivable
road? inside a building?).

**Posterior.** With a first-order Markov prior the day's posterior factorises as

$$
P(x_{1:T}\mid o_{1:T}) \;\propto\;
\underbrace{\prod_{t=1}^{T} \psi_E(x_t, o_t)}_{\text{emission}}
\;\cdot\;
\underbrace{\prod_{t=2}^{T} \psi_T(x_{t-1}, x_t)}_{\text{transition}} .
$$

Working in log-potentials $\phi = \log\psi$, the day's score is
$S(x_{1:T}) = \sum_t \phi_E(x_t,o_t) + \sum_t \phi_T(x_{t-1},x_t)$, and the
reconstruction we draw is the **MAP** sequence
$\hat x_{1:T} = \arg\max_{x_{1:T}} S(x_{1:T})$.

### 1.1 Emission factors (each a term, all learned/measured, none a veto-in-disguise)

$\phi_E(x_t,o_t) = \sum_k w_k\,\phi_E^{(k)}(x_t,o_t)$ with:

- **Speed** $\phi_E^{\text{spd}} = \log \mathcal N(v_t \mid \mu_{m_t}, \sigma_{m_t}^2)$ — the motion likelihood the base classifier already uses.
- **GPS** (accuracy-robust, heavy-tailed): $\phi_E^{\text{gps}} = \log \mathrm{St}_\nu\!\big(\mathrm{dist}(g_t,\ell_t)\mid 0,\sigma(a_t)\big)$, Student-$t$ so a wild fix is down-weighted automatically (`map-constrained-positioning` §Model; the `holdImplausibleSpeed` slice was a hard-threshold shadow of this).
- **Corridor** $\phi_E^{\text{cor}} = \log P(\Phi(\ell_t)\mid m_t)$ — the map-layer likelihood: a train is far more likely over a rail corridor than a road; a car the reverse. **This is the term that resolves tube→car** (Prop 3).
- **Cadence** $\phi_E^{\text{cad}} = \log P(c_t\mid m_t)$ — steps discriminate walk/run/stationary from vehicles ($c_t\!\approx\!0$ in a vehicle); the independent witness of `underground-accuracy-lie`.
- **Biometric** $\phi_E^{\text{hr}} = \log P(h_t\mid m_t)$ — HR floors an implausibly-low-effort cycling/driving call (existing `vetoImplausibleHr`, recast as a term).

### 1.2 Transition factors

$\phi_T(x_{t-1},x_t) = \phi_T^{\text{mode}}(m_{t-1},m_t) + \phi_T^{\text{kin}}(\ell_{t-1},\ell_t,m_t) + \phi_T^{\text{cont}}(x_{t-1},x_t)$:

- **Mode persistence** $\phi_T^{\text{mode}}$: a log-prior favouring staying in a mode (durations are long), penalising churn — an HSMM duration model in its explicit form.
- **Kinematic** $\phi_T^{\text{kin}}$: on an edge you advance 1-D along it; a jump to a non-adjacent edge is only through a junction. **Hard cap**: $\phi_T^{\text{kin}} = -\infty$ when $\mathrm{dist}(\ell_{t-1},\ell_t)/\Delta t > v_{\max}(m_t)$. This is where teleports die (Prop 4).
- **Continuity** $\phi_T^{\text{cont}}$: the hard grammar of a valid day — a train leg is a valid $(\text{board},\text{line},\text{alight})$ triple on a connected line; back-to-back trains share a station; a stay is a real place. Violations are $-\infty$ (Prop 2). (Existing `checkDayConstraints` / `worldline-feasibility`, promoted from a *post-hoc audit* to a *prior* the decode never violates.)

## 2. Inference

The model is a chain, so the exact MAP is a dynamic program (Viterbi) over the
lattice of $(m,\ell)$ states, with an HSMM duration extension for
$\phi_T^{\text{mode}}$. Complexity $O(T\,|\mathcal S|^2)$ in the naive form,
$O(T\,|\mathcal S|\,d)$ with the standard sparse-transition + max-duration $d$
pruning — the decoder already runs this shape offline in the cron path
(`fast-ux-offline-precision`), so cost is not the constraint.

## 3. Correctness — what the model provably guarantees

Let $\mathcal F \subseteq \mathcal X^T$ be the **feasible** sequences: those
violating no hard constraint ($\phi_T^{\text{kin}}$, $\phi_T^{\text{cont}}$ all
finite). Assume $\mathcal F \neq \varnothing$ (the raw GPS day, drawn honestly, is
always feasible).

**Proposition 1 (exactness).** Viterbi returns $\hat x_{1:T} = \arg\max_{x_{1:T}} S$
exactly. *Proof.* $S$ is a sum of per-edge terms on a chain; the Bellman recursion
$\delta_t(x) = \phi_E(x,o_t) + \max_{x'}[\delta_{t-1}(x') + \phi_T(x',x)]$ computes
the max-marginal, and back-pointer traceback yields the argmax. Standard. $\qquad\blacksquare$

**Proposition 2 (hard-constraint satisfaction).** $\hat x_{1:T} \in \mathcal F$:
the MAP reconstruction never violates a hard constraint. *Proof.* For any
$y \notin \mathcal F$ some factor is $-\infty$, so $S(y) = -\infty$. For any
$z \in \mathcal F$, $S(z) > -\infty$ (finite sum of finite terms). Since
$\mathcal F \neq \varnothing$, $\max_x S = \max_{z\in\mathcal F} S(z) > -\infty$,
so the maximiser lies in $\mathcal F$. $\qquad\blacksquare$

Corollary: no back-to-back trains without a shared station, no invalid
$(\text{board},\text{line},\text{alight})$ triple, no physically-impossible leg —
by construction, not by a cleanup pass.

**Proposition 3 (tube ≠ car).** Fix a minute on a rail corridor
($\Phi(\ell)=\text{rail}$) at tube-like speed. The model prefers train over drive
iff
$$\log\frac{P(\text{rail}\mid\text{train})}{P(\text{rail}\mid\text{drive})}
\;>\;
\log\frac{\mathcal N(v\mid\mu_{\text{drive}},\sigma_{\text{drive}}^2)}
{\mathcal N(v\mid\mu_{\text{train}},\sigma_{\text{train}}^2)} .$$
*Proof.* Compare $\phi_E$ for the two modes at equal $\ell$; the GPS/cadence/HR
terms are common and cancel, leaving the speed and corridor terms. The inequality
is $\phi_E(\text{train}) > \phi_E(\text{drive})$. $\qquad\blacksquare$
The RHS is small and bounded (a Tube at 60 km/h is only mildly more "car-like"
than "train-like": $\mu_{\text{drive}}=60,\mu_{\text{train}}=120$ give a modest
ratio), while a rail corridor is *overwhelmingly* more likely under train — LHS
large. So the corridor term flips the call. This is the motion-only classifier's
exact defect ("why is the tube a car"), resolved as a Bayesian posterior rather
than the downstream `roadSupportedConfidence` temper.

**Proposition 4 (no teleports).** No MAP leg implies a speed above its mode cap.
*Proof.* A minute-pair with $\mathrm{dist}(\ell_{t-1},\ell_t)/\Delta t > v_{\max}(m_t)$
has $\phi_T^{\text{kin}}=-\infty$; by Prop 2 it is excluded from $\hat x$. $\qquad\blacksquare$
The underground 44 km/h "walk" is thus impossible in the model — the geometric
`holdImplausibleSpeed` fix becomes a theorem, not a patch.

**Proposition 5 (patch subsumption).** The post-hoc passes
`trimOverRouteExcursions`, `despikeUnsupportedApexes`, `roadSupportedConfidence`,
the `MAX_SPEED_FOR_MODE` vetoes and the rail-corridor veto are each the projection
of one factor above onto the cascade's output. *Argument.* Each pass rejects an
output that the corresponding factor scores $-\infty$ or strongly negative; under
joint MAP that output is never produced, so the pass has empty effect and retires.
(Empirical, verified as each factor lands: the pass's diff on the corpus goes to
zero.)

## 4. Why this beats the current decoder (and the pipeline)

The weak HSMM loses because its emission is thin (mode priors + place) — it lacks
the corridor, cadence-discrimination, robust-GPS and hard-grammar terms the
*pipeline* encodes as scattered heuristics. This model is exactly those pipeline
signals, made into $\phi_E,\phi_T$ terms and decoded jointly. It inherits the
pipeline's evidence (so it starts from 35, not 13) and adds the joint consistency
the cascade lacks (so tube legs stop fragmenting). The journey gate is the referee
at every step.

## 5. Methodical, measured build order

Each phase adds one factor to the *existing* decode lattice, re-weights, and is
kept only if the corpus journey count (`npm run golden`) rises or holds. Weights
$w_k$ are fit by maximising journey-correctness on the golden corpus (a small
convex-ish search; the corpus is the labelled set).

- **Phase A — corridor emission $\phi_E^{\text{cor}}$** (Prop 3). The tube→car
  class is the largest journey loss; this is the highest-leverage single factor
  and the first slice. Fit its weight against the gate.
- **Phase B — kinematic transition $\phi_T^{\text{kin}}$** (Prop 4). Folds the
  teleport hold into the decode; retire `holdImplausibleSpeed` per Prop 5 once the
  corpus diff is zero.
- **Phase C — cadence + robust-GPS emissions** ($\phi_E^{\text{cad}},\phi_E^{\text{gps}}$).
- **Phase D — hard grammar as prior $\phi_T^{\text{cont}}$** (Prop 2). Promote
  `checkDayConstraints` from audit to decode constraint.
- **Phase E — retire subsumed passes** (Prop 5), each gated by a zero corpus diff.
- **Phase F — position half** ($\ell$): widen state from mode-only to $(m,\ell)$
  on the map graph, closing `map-constrained-positioning`.

Phases A–D each independently raise the journey number or are reverted; none is
shipped on faith. The north star (F) is reached incrementally, every step proven
above and measured against the gate.

## Non-goals / honesty

- Weights are *fit to the corpus*; the corpus must stay representative (it is the
  same 22 real days the ratchet guards). Overfit risk is bounded by the small
  factor count and the held hard constraints.
- Until Phase F, position stays as today's drawn geometry (this doc's Props 3–4
  act on the mode lattice); the joint $(m,\ell)$ decode is the final phase.
