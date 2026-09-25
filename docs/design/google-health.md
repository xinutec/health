# Google Health API — the biometric source

The Fitbit Web API is decommissioned in September 2026. Every biometric stream
that Google Health carries is read from it; the roster that says which API owns
which stream, with the measurement behind each flip, is
`rust/backend/src/google/source.rs` (`STREAMS`). ⚠ A stream has exactly one
owner: the tables are `ON DUPLICATE KEY UPDATE`, so two writers would flip a
value with whichever job ran last.

## The API

- A cloud REST API: the backend polls it server-to-server with a stored refresh
  token. Distinct from on-device Health Connect, which is the only route for
  the streams Google does not carry (`Owner::HealthConnect` in the roster).
- One data model: `users/me/dataTypes/{type}/dataPoints`. Aggregates refuse
  `list` and answer only `rollup`; `steps` under `list` is per-interval samples,
  not a day sum (`rust/backend/src/cli/google.rs`, `Source`).
- OAuth 2.0 with PKCE and `access_type=offline`. Scope for body metrics:
  `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`;
  sleep, activity and ECG have their own `googlehealth.*.readonly` scopes.
- Propagation lag: a weigh-in reaches the phone at once and the cloud API
  later, so a sync right after weighing can miss it. The next tick catches it.

## Credentials

Google Cloud project `tox-chat` (number 553831388950); "Xinutec Health" is the
OAuth client inside it, a Desktop client. The OAuth app is published
("In production" since 2026-07-18), so its refresh tokens persist; no CASA
assessment is needed for personal use. The client secret and refresh token live
in the k8s secret `health/health-google` (`GH_CLIENT_ID`, `GH_CLIENT_SECRET`,
`GH_REFRESH_TOKEN`), wired into the sync CronJob's env. A Desktop client's
secret cannot be re-viewed; if lost, create a new client.

## Re-authenticating

`scripts/ghealth-spike.mjs` runs the loopback PKCE flow and prints a refresh
token. Approve the consent URL in any browser; if the `127.0.0.1:8765` redirect
cannot load, copy the `code` parameter out of the address bar and feed it to
the still-running script:

```
nix-shell -p nodejs_24 --run 'node scripts/ghealth-spike.mjs'
curl -sS -G http://127.0.0.1:8765/ --data-urlencode 'code=<CODE>'
```

Then replace the secret and let the next sync tick write:

```
kubectl -n health create secret generic health-google --from-env-file=<file> \
  --dry-run=client -o yaml | kubectl apply -f -
```

## What the shutdown still costs

`daily_activity.minutes_sedentary` and `.active_score` have no Google source
(the roster's at-risk test keeps them visible), and four stored-and-never-read
columns NULL forward: `hrv_intraday.{coverage,hf,lf}`, `heart_rate_zones.calories`.

⚠ The comparison instruments (`backend google-compare*`) read both APIs while
both still answer; after the shutdown a discrepancy is permanent and invisible.
`probe_one`'s `pageSize=1` reports session and interval types as empty — two
streams were nearly lost to that.
