//! Signing in: Nextcloud for identity, Fitbit for data (#982).
//!
//! # Two providers, two different jobs
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
//!
//! Fitbit is different and keeps `state` as the carrier: it returns `state`
//! faithfully, and its pending entry holds a PKCE verifier that has no business
//! in a cookie.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Redirect, Response};
use axum::{Extension, Json};
use axum_extra::extract::cookie::CookieJar;
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::auth::session::{self, UserSession};
use crate::lean;
use crate::state::AppState;

/// The cookie carrying a half-finished Nextcloud login.
const PENDING_COOKIE: &str = "oauth_pending";

/// Every scope the dashboard reads. Requested once, at link time — Fitbit has no
/// incremental consent, so a scope missing here means a silent 403 later.
const FITBIT_SCOPES: &str = "activity heartrate sleep weight nutrition profile \
oxygen_saturation respiratory_rate temperature cardio_fitness electrocardiogram \
location settings";

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

fn text(status: StatusCode, body: &'static str) -> Response {
    (status, body).into_response()
}

fn oops(e: &anyhow::Error, what: &str) -> Response {
    tracing::error!(error = %format!("{e:#}"), "{what}");
    text(
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

    let nonce = match session::mint_id() {
        Ok(n) => n,
        Err(e) => return oops(&e, "minting a login nonce"),
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let (ttl_ms, payload) = match (lean::pending_ttl_ms(), ()) {
        (Ok(ttl), ()) => match lean::encode_pending(now_ms + ttl, &nonce, p.return_to.as_deref()) {
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
        &format!("{}/index.php/apps/oauth2/authorize", nc_base(&st)),
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

    // ⚠ The cookie is the binding, because NC may have dropped `state`.
    let Some(cookie) = jar.get(PENDING_COOKIE) else {
        return text(
            StatusCode::FORBIDDEN,
            "Invalid or expired OAuth state. Please try logging in again.",
        );
    };
    let raw = match session::verify_value(secret, cookie.value()) {
        Ok(Some(v)) => v,
        Ok(None) => {
            return text(
                StatusCode::FORBIDDEN,
                "Invalid or expired OAuth state. Please try logging in again.",
            );
        }
        Err(e) => return oops(&e, "verifying the pending-login cookie"),
    };
    let pending = match lean::decode_pending(&raw) {
        Ok(Some(pd)) => pd,
        Ok(None) => {
            return text(
                StatusCode::FORBIDDEN,
                "Invalid or expired OAuth state. Please try logging in again.",
            );
        }
        Err(e) => return oops(&e, "decoding the pending login"),
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    match lean::accept_pending(
        pending.expires_at,
        &pending.nonce,
        p.state.as_deref(),
        now_ms,
    ) {
        Ok(true) => {}
        Ok(false) => {
            return text(
                StatusCode::FORBIDDEN,
                "Invalid or expired OAuth state. Please try logging in again.",
            );
        }
        Err(e) => return oops(&e, "judging the pending login"),
    }

    let Some(code) = p.code.as_deref().filter(|c| !c.is_empty()) else {
        return text(StatusCode::BAD_REQUEST, "Missing authorization code.");
    };

    match finish_nextcloud_login(&st, secret, code, now_ms).await {
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

/// Exchange the code, look up who it is, seat a session. Returns the signed
/// cookie value.
async fn finish_nextcloud_login(
    st: &AppState,
    secret: &str,
    code: &str,
    now_ms: i64,
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

/// `GET /fitbit/auth` — start the Fitbit link. Requires a session already.
pub async fn fitbit_auth(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
) -> Response {
    let verifier = match session::mint_id() {
        Ok(v) => v,
        Err(e) => return oops(&e, "minting a PKCE verifier"),
    };
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    // ⚠ The verifier is held server-side against the state token. It must never
    // reach the browser: the whole point of PKCE is that whoever redeems the
    // code proves they started the flow.
    let state_token = match session::mint_id() {
        Ok(s) => s,
        Err(e) => return oops(&e, "minting a Fitbit state"),
    };
    st.oauth_states.put(
        &state_token,
        chrono::Utc::now().timestamp_millis(),
        (session.user_id.clone(), verifier),
    );

    // ⚠ The OAuth routes genuinely need these; `Config::from_env` requires
    // them, so absence here means the process was started with a BATCH config.
    let Some(fb) = st.cfg.fitbit.as_ref() else {
        return oops(
            &anyhow::anyhow!("the Fitbit credentials are absent"),
            "starting the Fitbit OAuth flow with a batch config",
        );
    };
    let url = match reqwest::Url::parse_with_params(
        "https://www.fitbit.com/oauth2/authorize",
        &[
            ("client_id", fb.client_id.clone()),
            ("response_type", "code".to_string()),
            ("scope", FITBIT_SCOPES.to_string()),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256".to_string()),
            (
                "redirect_uri",
                env_or(
                    "FITBIT_REDIRECT_URI",
                    "https://health.xinutec.org/fitbit/callback",
                ),
            ),
            ("state", state_token.clone()),
        ],
    ) {
        Ok(u) => u.to_string(),
        Err(e) => return oops(&anyhow::Error::from(e), "building the Fitbit authorize URL"),
    };
    Redirect::to(&url).into_response()
}

/// `GET /fitbit/callback` — redeem the code and store the tokens.
pub async fn fitbit_callback(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
    Query(p): Query<CallbackParams>,
) -> Response {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let Some(state_token) = p.state.as_deref().filter(|s| !s.is_empty()) else {
        return text(
            StatusCode::FORBIDDEN,
            "Invalid or expired OAuth state. Please try again from /fitbit/auth.",
        );
    };
    let Some((state_user, verifier)) = st.oauth_states.take(state_token, now_ms) else {
        return text(
            StatusCode::FORBIDDEN,
            "Invalid or expired OAuth state. Please try again from /fitbit/auth.",
        );
    };
    // ⚠ The state's user must be THIS session's user. Without this check a
    // stolen callback URL would link the attacker's Fitbit to whoever opened it.
    if state_user != session.user_id {
        return text(
            StatusCode::FORBIDDEN,
            "Session user does not match OAuth state. Please try again.",
        );
    }
    let Some(code) = p.code.as_deref().filter(|c| !c.is_empty()) else {
        return text(StatusCode::BAD_REQUEST, "Missing authorization code.");
    };

    match finish_fitbit_link(&st, &state_user, &verifier, code).await {
        Ok(scopes) => Json(json!({
            "success": true,
            "linkedTo": state_user,
            "scopes": scopes,
            "message": "Fitbit authorization successful. You can close this page.",
        }))
        .into_response(),
        Err(e) => {
            tracing::error!(error = %format!("{e:#}"), "Fitbit token exchange failed");
            text(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Fitbit authorization failed. Please try again.",
            )
        }
    }
}

async fn finish_fitbit_link(
    st: &AppState,
    user_id: &str,
    verifier: &str,
    code: &str,
) -> anyhow::Result<String> {
    #[derive(Deserialize)]
    struct Tokens {
        access_token: String,
        refresh_token: String,
        expires_in: i64,
        scope: String,
    }

    // ⚠ The OAuth routes genuinely need these; `Config::from_env` requires
    // them, so absence here means the process was started with a BATCH config.
    let Some(fb) = st.cfg.fitbit.as_ref() else {
        anyhow::bail!(
            "the Fitbit credentials are absent — this process was started with a batch config"
        );
    };
    let basic = base64::engine::general_purpose::STANDARD
        .encode(format!("{}:{}", fb.client_id, fb.client_secret));
    let redirect = env_or(
        "FITBIT_REDIRECT_URI",
        "https://health.xinutec.org/fitbit/callback",
    );
    let res = st
        .http
        .post("https://api.fitbit.com/oauth2/token")
        .header(header::AUTHORIZATION, format!("Basic {basic}"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("client_id", fb.client_id.as_str()),
            ("code_verifier", verifier),
            ("redirect_uri", &redirect),
        ])
        .send()
        .await?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!("Fitbit token exchange: {status} {body}");
    }
    let t: Tokens = res.json().await?;

    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(t.expires_in);
    sqlx::query(
        "INSERT INTO tokens (user_id, access_token, refresh_token, expires_at, scopes, status) \
         VALUES (?, ?, ?, ?, ?, 'active') \
         ON DUPLICATE KEY UPDATE access_token = VALUES(access_token), \
         refresh_token = VALUES(refresh_token), expires_at = VALUES(expires_at), \
         scopes = VALUES(scopes), status = 'active'",
    )
    .bind(user_id)
    .bind(&t.access_token)
    .bind(&t.refresh_token)
    .bind(expires_at.format("%Y-%m-%d %H:%M:%S").to_string())
    .bind(&t.scope)
    .execute(&st.pool)
    .await?;
    Ok(t.scope)
}
