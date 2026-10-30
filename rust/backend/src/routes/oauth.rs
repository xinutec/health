//! Signing in: Nextcloud for identity.
//!
//! ⚠ Nextcloud OAuth here is IDENTITY-ONLY. The access token it returns is used
//! exactly once, to ask "who is this", and then discarded — API access runs on a
//! long-lived app password obtained separately through Login Flow v2
//! (`routes::nextcloud_connect`).
//!
//! That split is not tidiness. NC's OAuth refresh tokens rotate single-use, and
//! the auth pod and the sync cron raced for them: every few hours one lost and
//! flipped the account to `needs_reauth`. Login Flow v2 has no refresh dance.
//! OAuth survives here only because the SPA needs a session cookie before it can
//! drive the connect button.
//!
//! # ⚠ Nextcloud DROPS `state`, so the pending login rides in a cookie
//!
//! When the browser holds no NC session, `oauth2/authorize` bounces to NC's own
//! login flow and loses every query parameter on the way — the callback arrives
//! with `state=` EMPTY. A server that looks the pending login up by `state`
//! cannot sign in a cookie-less browser at all. That is not theoretical: it is
//! what stranded the sibling fleetwatch service's Android WebView.
//!
//! So the pending login travels in a signed cookie of ours, which binds it to
//! the browser that started the login — the property `state` was there to prove.
//! `state` is still sent, and still checked whenever NC returns it.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Redirect, Response};

use axum_extra::extract::cookie::CookieJar;

use serde::Deserialize;

use crate::auth::session;
use crate::lean;
use crate::state::AppState;

/// The cookie carrying a half-finished Nextcloud login.
const PENDING_COOKIE: &str = "oauth_pending";

#[derive(Deserialize)]
pub struct LoginParams {
    return_to: Option<String>,
}

#[derive(Deserialize)]
pub struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
}

fn nc_base(st: &AppState) -> String {
    st.cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| crate::classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string())
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// A sign-in that could not be finished, drawn as a page: these routes are where
/// a browser is sent, and a bare status in place of the app reads as it broken.
fn sign_in_problem(status: StatusCode, said: &'static str) -> Response {
    let body = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>Sign-in did not finish</title><style>\
         body{{font:16px/1.5 system-ui,-apple-system,sans-serif;margin:0;\
         min-height:100vh;display:grid;place-items:center;padding:1.5rem;color:#1a1a1a}}\
         main{{max-width:26rem}}h1{{font-size:1.2rem;margin:0 0 .5rem}}\
         p{{margin:0 0 1.5rem;color:#555}}\
         a{{display:inline-block;padding:.65rem 1.1rem;border-radius:.5rem;\
         background:#1b6ac9;color:#fff;text-decoration:none}}\
         </style></head><body><main><h1>Sign-in did not finish</h1>\
         <p>{said}</p><a href=\"/login\">Try again</a></main></body></html>"
    );
    (
        status,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        body,
    )
        .into_response()
}

fn oops(e: &anyhow::Error, what: &str) -> Response {
    tracing::error!(error = %format!("{e:#}"), "{what}");
    sign_in_problem(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Authentication failed. Please try again.",
    )
}

/// `GET /login` — start the Nextcloud identity flow.
pub async fn login(State(st): State<AppState>, Query(p): Query<LoginParams>) -> Response {
    let Some(secret) = st.cfg.session_secret.as_deref() else {
        return oops(
            &anyhow::anyhow!("SESSION_SECRET is not set"),
            "login without a signing key",
        );
    };
    start_login(&st, secret, p.return_to.as_deref(), false)
}

/// Send the browser to Nextcloud's authorize page with a fresh nonce, in the
/// URL and in the signed pending-login cookie. `retried` marks the one attempt
/// a lost `state` earns.
fn start_login(st: &AppState, secret: &str, return_to: Option<&str>, retried: bool) -> Response {
    let nonce = match session::mint_id() {
        Ok(n) => n,
        Err(e) => return oops(&e, "minting a login nonce"),
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let (ttl_ms, payload) = match (lean::pending_ttl_ms(), ()) {
        (Ok(ttl), ()) => match lean::encode_pending(now_ms + ttl, &nonce, retried, return_to) {
            Ok(v) => (ttl, v),
            Err(e) => return oops(&e, "encoding the pending login"),
        },
        (Err(e), ()) => return oops(&e, "reading the pending TTL"),
    };
    let cookie_value = session::sign_value(secret, &payload);

    // ⚠ Built with a URL parser rather than `format!`. A client id or redirect
    // containing a `&` would otherwise inject a parameter into the authorize
    // request, and the value that carries an attacker's text here is `state`.
    let url = match reqwest::Url::parse_with_params(
        &format!("{}/index.php/apps/oauth2/authorize", nc_base(st)),
        &[
            ("client_id", env_or("NC_CLIENT_ID", "")),
            ("response_type", "code".to_string()),
            (
                "redirect_uri",
                env_or(
                    "NC_REDIRECT_URI",
                    "https://health.xinutec.org/auth/callback",
                ),
            ),
            ("state", nonce.clone()),
        ],
    ) {
        Ok(u) => u.to_string(),
        Err(e) => return oops(&anyhow::Error::from(e), "building the authorize URL"),
    };

    // ⚠ `SameSite=Lax`, NOT Strict. The callback arrives as a top-level
    // navigation FROM Nextcloud, and a Strict cookie would not be sent with it —
    // the login would fail with nothing to point at.
    let cookie = format!(
        "{PENDING_COOKIE}={cookie_value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age={}",
        ttl_ms / 1000
    );
    let mut headers = HeaderMap::new();
    if let Ok(v) = cookie.parse() {
        headers.insert(header::SET_COOKIE, v);
    }
    (headers, Redirect::to(&url)).into_response()
}

/// `GET /auth/callback` — finish it.
pub async fn callback(
    State(st): State<AppState>,
    jar: CookieJar,
    Query(p): Query<CallbackParams>,
) -> Response {
    let Some(secret) = st.cfg.session_secret.as_deref() else {
        return oops(
            &anyhow::anyhow!("SESSION_SECRET is not set"),
            "callback without a signing key",
        );
    };

    // ⚠ The cookie names the login this browser started; the URL's `state` must
    // equal its nonce before any code is exchanged.
    let Some(cookie) = jar.get(PENDING_COOKIE) else {
        return sign_in_problem(
            StatusCode::FORBIDDEN,
            "Invalid or expired OAuth state. Please try logging in again.",
        );
    };
    let raw = match session::verify_value(secret, cookie.value()) {
        Ok(Some(v)) => v,
        Ok(None) => {
            return sign_in_problem(
                StatusCode::FORBIDDEN,
                "Invalid or expired OAuth state. Please try logging in again.",
            );
        }
        Err(e) => return oops(&e, "verifying the pending-login cookie"),
    };
    let pending = match lean::decode_pending(&raw) {
        Ok(Some(pd)) => pd,
        Ok(None) => {
            return sign_in_problem(
                StatusCode::FORBIDDEN,
                "Invalid or expired OAuth state. Please try logging in again.",
            );
        }
        Err(e) => return oops(&e, "decoding the pending login"),
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let url_state = p.state.as_deref().unwrap_or_default();
    let proof = match lean::accept_pending(
        pending.expires_at,
        &pending.nonce,
        pending.retried,
        p.state.as_deref(),
        now_ms,
    ) {
        Ok(lean::Callback::Accept) => StateMatched::check(url_state, &pending.nonce),
        // The code is not exchanged: without `state` nothing ties it to this
        // browser. Nextcloud now has a session, so `state` returns.
        Ok(lean::Callback::Retry) => {
            tracing::info!("login callback without state — authorizing again");
            return start_login(&st, secret, pending.return_to.as_deref(), true);
        }
        Ok(lean::Callback::Refuse) => None,
        Err(e) => return oops(&e, "judging the pending login"),
    };
    let Some(proof) = proof else {
        return sign_in_problem(
            StatusCode::FORBIDDEN,
            "Invalid or expired OAuth state. Please try logging in again.",
        );
    };

    let Some(code) = p.code.as_deref().filter(|c| !c.is_empty()) else {
        return sign_in_problem(StatusCode::BAD_REQUEST, "Missing authorization code.");
    };

    match finish_nextcloud_login(&st, secret, code, now_ms, proof).await {
        Err(e) => oops(&e, "completing the Nextcloud login"),
        Ok(signed) => {
            let target = lean::validate_return_to(pending.return_to.as_deref())
                .unwrap_or_else(|_| "/".to_string());
            let policy = match lean::session_policy() {
                Ok(pl) => pl,
                Err(e) => return oops(&e, "reading the session policy"),
            };
            let mut headers = HeaderMap::new();
            let set = format!(
                "{}={signed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age={}",
                policy.cookie_name, policy.cookie_max_age_s
            );
            if let Ok(v) = set.parse() {
                headers.append(header::SET_COOKIE, v);
            }
            // ⚠ The login is over: drop the pending cookie so a stale one cannot
            // be replayed inside its remaining TTL.
            if let Ok(v) = format!("{PENDING_COOKIE}=; Path=/; HttpOnly; Secure; Max-Age=0").parse()
            {
                headers.append(header::SET_COOKIE, v);
            }
            (headers, Redirect::to(&target)).into_response()
        }
    }
}

/// Proof that a callback's `state` equalled the nonce this server stored for
/// the sign-in. [`finish_nextcloud_login`] takes one by value and only
/// [`StateMatched::check`] makes one, so no code is redeemed on a path that
/// skipped the comparison (RFC 6749 §10.12; dev-lint
/// DL-RUST-OAUTH-EXCHANGE-UNPROVEN checks the shape).
#[derive(Debug, PartialEq, Eq)]
pub struct StateMatched(());

impl StateMatched {
    /// The proof, when `url_state` is present and equals `stored`.
    pub fn check(url_state: &str, stored: &str) -> Option<Self> {
        use subtle::ConstantTimeEq;
        let equal: bool = url_state.as_bytes().ct_eq(stored.as_bytes()).into();
        (!url_state.is_empty() && equal).then_some(Self(()))
    }
}

/// Exchange the code, look up who it is, seat a session. Returns the signed
/// cookie value.
async fn finish_nextcloud_login(
    st: &AppState,
    secret: &str,
    code: &str,
    now_ms: i64,
    _proof: StateMatched,
) -> anyhow::Result<String> {
    #[derive(Deserialize)]
    struct Tokens {
        access_token: String,
    }
    #[derive(Deserialize)]
    struct UserWrap {
        ocs: Ocs,
    }
    #[derive(Deserialize)]
    struct Ocs {
        data: UserData,
    }
    #[derive(Deserialize)]
    struct UserData {
        id: String,
        displayname: String,
    }

    let base = nc_base(st);
    let redirect = env_or(
        "NC_REDIRECT_URI",
        "https://health.xinutec.org/auth/callback",
    );
    let res = st
        .http
        .post(format!("{base}/index.php/apps/oauth2/api/v1/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("client_id", &env_or("NC_CLIENT_ID", "")),
            ("client_secret", &env_or("NC_CLIENT_SECRET", "")),
            ("redirect_uri", &redirect),
        ])
        .send()
        .await?;
    if !res.status().is_success() {
        let status = res.status();
        anyhow::bail!("Nextcloud token exchange failed: {status}");
    }
    let tokens: Tokens = res.json().await?;

    // ⚠ Used ONCE, then discarded. See the module note on why API access does
    // not run on this token.
    let user: UserWrap = st
        .http
        .get(format!("{base}/ocs/v2.php/cloud/user?format=json"))
        .bearer_auth(&tokens.access_token)
        .header("OCS-APIRequest", "true")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    session::create(
        &st.pool,
        secret,
        &user.ocs.data.id,
        &user.ocs.data.displayname,
        now_ms,
    )
    .await
}

/// `POST /logout` — destroy the session row and clear the cookie.
pub async fn logout(State(st): State<AppState>, jar: CookieJar) -> Response {
    if let Some(secret) = st.cfg.session_secret.as_deref()
        && let Ok(policy) = lean::session_policy()
        && let Some(c) = jar.get(&policy.cookie_name)
    {
        // ⚠ The ROW goes, not just the cookie. Clearing only the cookie would
        // leave a valid session id that anyone holding a copy could keep using.
        if let Err(e) = session::destroy(&st.pool, secret, c.value()).await {
            tracing::warn!(error = %format!("{e:#}"), "destroying the session row failed");
        }
    }
    let mut headers = HeaderMap::new();
    let name = lean::session_policy()
        .map(|p| p.cookie_name)
        .unwrap_or_else(|_| "session".to_string());
    if let Ok(v) = format!("{name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0").parse() {
        headers.insert(header::SET_COOKIE, v);
    }
    (headers, Redirect::to("/")).into_response()
}
