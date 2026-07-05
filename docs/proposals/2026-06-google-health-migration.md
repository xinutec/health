# Google Health API migration (Fitbit Web API sunset)

Status: **weight slice shipped; full migration + durable auth deferred** (decision 2026-06-19).
Tracking: task #260.

## Why

Google is turning down the **legacy Fitbit Web API** (`api.fitbit.com`) in
**September 2026** and replacing it with the **Google Health API**
(`health.googleapis.com`). health-sync authenticates against the legacy API
(`FitbitClient` + Fitbit OAuth), so the whole Fitbit ingestion path must move
to Google OAuth + the Google Health API before that date or it goes dark.

This already bit one metric early: **weight**. The body scale (Hume) writes
via **Health Connect → Google Health**, which the legacy Fitbit Web API never
receives. So the Fitbit weight feed froze (forward-filled) in Apr 2026 when
that path switched, while the real weigh-ins only existed on the Google side.

## What's done — weight slice (shipped)

- `src/google/oauth.ts` — refresh-token → access-token (Google OAuth 2.0).
- `src/google/health.ts` — Google Health v4 client; paginates
  `GET https://health.googleapis.com/v4/users/me/dataTypes/weight/dataPoints`.
- `src/google/body.ts` — maps weigh-ins → `body` table. Google returns real,
  individually-timestamped measurements (integer grams + sample time), not a
  forward-filled daily series, so for the covered window we **replace** the
  stale Fitbit rows with the real values.
- `src/cli/sync-google-weight.ts` — dry-run by default; `--apply` writes.
- `scripts/ghealth-spike.mjs` — one-time PKCE loopback OAuth to mint a refresh
  token (and a quick read of weight data points).
- Backfilled the real weigh-in history; the Trends weight chart now shows the
  true series instead of the frozen value.

### Key facts (so we don't re-research)

- Google Health API is a **cloud REST API** — a backend with a stored refresh
  token polls it server-to-server, no phone needed (distinct from on-device
  Health Connect).
- Unified data model: `users/me/dataTypes/{type}/dataPoints` for every metric.
- OAuth: `accounts.google.com/o/oauth2/v2/auth` + `oauth2.googleapis.com/token`,
  PKCE, `access_type=offline`.
- Scope for body metrics:
  `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`
  (sleep / activity / ecg have their own `googlehealth.*.readonly` scopes).
- Google Cloud project **"Xinutec Health"**; Desktop OAuth client
  `553831388950-nb9umruv42dqlpnk1986t46h2j9bjv98.apps.googleusercontent.com`.
- Client **secret** and **refresh token** live in **k8s secret
  `health/health-google`** (keys `GH_CLIENT_ID` / `GH_CLIENT_SECRET` /
  `GH_REFRESH_TOKEN`), never in the repo. Store only — not wired to the
  deployment; sync is the manual CLI.
- A Desktop client's secret cannot be re-viewed after creation; if lost, create
  a new Desktop client rather than trying to recover it.
- Restricted-scope verification is **not** needed for personal use (≤100 test
  users).
- **Propagation lag:** a fresh weigh-in reaches Health Connect and the app
  immediately but takes time to surface on the Google *cloud* API this backend
  polls, so a sync run right after weighing can miss it — re-run
  `sync-google-weight --apply` a little later.

## Durability — DEFERRED (use the 7-day token until it breaks)

The OAuth app is in **Testing** publishing status, where Google **revokes
refresh tokens after 7 days**. So headless sync stops roughly weekly until
re-auth.

**Decision (2026-06-19): do not productionize yet.** Use the 7-day token; when
it expires and weight stops updating, either re-auth manually (below) or, if it
becomes annoying, do the one-time permanent fix. Don't build a cron that would
silently rot in 7 days.

### Permanent fix (when we want it) — free, no verification

1. OAuth consent screen → **Publish app** (Testing → In production), at
   `console.cloud.google.com/auth/audience`. Free; **no CASA verification**
   needed for personal use — you just click through a one-time "unverified app"
   warning at consent. In-production refresh tokens **persist long-term**, like
   the old Fitbit token did.
2. Re-auth once to mint a long-lived refresh token.
3. Store `GH_CLIENT_ID` / `GH_CLIENT_SECRET` / `GH_REFRESH_TOKEN` as a k8s
   secret; add a daily CronJob running `sync-google-weight --apply`.

The paid **CASA** security assessment ($500–$4,500+/yr, recurring) is **only**
for removing the warning / going multi-user public — irrelevant here.

### How to re-auth manually (when the 7-day token expires)

The Mac is **headless**, so the loopback redirect can't reach it; use the
copy-the-`code` path:

```
cd ~/Code/health
nix develop -c npm run build                 # dist/ for the sync CLI

# Creds from the k8s secret into the env (GH_CLIENT_ID / GH_CLIENT_SECRET /
# GH_REFRESH_TOKEN). Inspect with:
#   kubectl -n health get secret health-google -o jsonpath='{.data}'
nix-shell -p nodejs_24 --run 'node scripts/ghealth-spike.mjs'   # prints a consent URL

# Approve the URL in ANY browser. The redirect to http://127.0.0.1:8765/?...code=...
# will fail to load — copy the `code` param out of the address bar, then feed it
# to the still-running spike (it holds the PKCE verifier in memory):
curl -sS -G http://127.0.0.1:8765/ --data-urlencode 'code=<CODE>'
# the spike prints the new [refresh_token] and a weight sample.

# With GH_CLIENT_ID/SECRET/REFRESH_TOKEN in the env, write the real weigh-ins:
./scripts/prod-db.sh node dist/cli/sync-google-weight.js pippijn --apply
```

Then update the stored token so the next run starts from a live one:
`kubectl -n health create secret generic health-google --from-env-file=<file> --dry-run=client -o yaml | kubectl apply -f -`
(the token is still 7-day until the app is Published — see the permanent fix above).

## Remaining (before Sep 2026)

Migrate the other metrics onto the same v4 `dataPoints` model + a proper Google
OAuth token-manager in the app, then retire the Fitbit Web API:
heart rate (incl. intraday), sleep, steps/activity, HRV, SpO2, respiratory
rate, temperature. Each is `users/me/dataTypes/{type}/dataPoints` under the
matching `googlehealth.*.readonly` scope.
