//! Same-origin media proxy `GET /v1/{app}/media/:id` (PRD §12; app prefix PLAN.md C-A2). The web app runs under
//! `Cross-Origin-Embedder-Policy: require-corp`, so iNat photos are served from here with
//! `Cross-Origin-Resource-Policy: same-origin`. `:id` is a sighting id; the upstream URL is its
//! `photo_url`, never a client-supplied URL.
//!
//! SSRF guard, applied to the first URL and to every redirect hop:
//! - scheme https, default port, no userinfo;
//! - host exactly one of [`ALLOWED_HOSTS`]; IP literals are refused;
//! - DNS answers are filtered to public unicast addresses by [`GuardedResolver`], so an
//!   allowlisted name that resolves to a private, loopback or link-local address is refused;
//! - no proxy (a proxy would resolve names itself);
//! - redirects are followed by hand (at most [`MAX_REDIRECTS`]) and only to allowlisted URLs.
//!
//! The body must be at most [`MAX_BYTES`], declared `image/*`, and sniff as JPEG, PNG, GIF or
//! WebP (SVG is refused: it can carry script). Bytes are cached in the Archive under
//! `media/<id>`.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::Path;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Router};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::Url;

use crate::app::AppRegistry;
use crate::state::AppState;

pub const ALLOWED_HOSTS: [&str; 2] = ["inaturalist-open-data.s3.amazonaws.com", "static.inaturalist.org"];
pub const MAX_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_REDIRECTS: usize = 3;
pub const CACHE_CONTROL: &str = "public, max-age=86400";

/// Which upstream URLs may be fetched. Production is [`Policy::inaturalist`]; tests swap in a
/// resolver pinned to a local server.
#[derive(Clone)]
pub struct Policy {
    pub hosts: Vec<String>,
    pub require_https: bool,
    /// Accept explicit ports (tests only; production allows the scheme's default port only).
    pub any_port: bool,
    pub resolver: GuardedResolver,
}

impl Policy {
    pub fn inaturalist() -> Policy {
        Policy {
            hosts: ALLOWED_HOSTS.iter().map(|h| h.to_string()).collect(),
            require_https: true,
            any_port: false,
            resolver: GuardedResolver::default(),
        }
    }

    /// Why `url` may not be fetched, if it may not.
    pub fn check(&self, url: &Url) -> Result<(), String> {
        match url.scheme() {
            "https" => {}
            "http" if !self.require_https => {}
            s => return Err(format!("scheme {s:?} is not allowed")),
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("credentials in the URL are not allowed".into());
        }
        if url.host_str().is_none() {
            return Err("URL has no host".into());
        }
        // `domain()` is None for IPv4 and IPv6 literals.
        let host = url.domain().ok_or("IP literal hosts are not allowed")?.to_ascii_lowercase();
        if !self.hosts.contains(&host) {
            return Err(format!("host {host:?} is not on the media allowlist"));
        }
        if url.port().is_some() && !self.any_port {
            return Err("explicit ports are not allowed".into());
        }
        Ok(())
    }
}

/// DNS resolver that only returns public unicast addresses. `pinned` maps names to fixed
/// addresses (tests); pinned answers are filtered like real ones, except that loopback may be
/// allowed so a test can point an allowlisted name at a local server.
#[derive(Clone, Default)]
pub struct GuardedResolver {
    pub pinned: HashMap<String, Vec<SocketAddr>>,
    pub allow_loopback: bool,
}

/// Error type the resolver returns, found again in the error chain to answer 403 instead of 502.
#[derive(Debug)]
pub struct Blocked(pub String);

impl std::fmt::Display for Blocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Blocked {}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        let pinned = self.pinned.get(&host).cloned();
        let allow_loopback = self.allow_loopback;
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = match pinned {
                Some(addrs) => addrs,
                None => tokio::net::lookup_host((host.as_str(), 0)).await?.collect(),
            };
            let ok: Vec<SocketAddr> =
                addrs.into_iter().filter(|a| is_public(a.ip()) || (allow_loopback && a.ip().is_loopback())).collect();
            if ok.is_empty() {
                return Err(Box::new(Blocked(format!("{host} resolves to no public address"))) as _);
            }
            Ok(Box::new(ok.into_iter()) as Addrs)
        })
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || a == 0
        || (a == 100 && (64..128).contains(&b)) // shared address space (CGNAT)
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 198 && (18..20).contains(&b)) // benchmarking
        || a >= 240) // reserved
}

/// Public unicast only. IPv6 forms that embed an IPv4 address (mapped, NAT64, 6to4) are judged
/// by that address.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let s = v6.segments();
            if s[0] == 0x64 && s[1] == 0xff9b {
                return is_public_v4(Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8));
            }
            if s[0] == 0x2002 {
                return is_public_v4(Ipv4Addr::new((s[1] >> 8) as u8, s[1] as u8, (s[2] >> 8) as u8, s[2] as u8));
            }
            !(v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // link local
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || s[..6] == [0; 6]) // IPv4-compatible and other ::/96 forms
        }
    }
}

/// Image type by magic bytes. Only raster formats a browser renders without script.
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

pub struct MediaProxy {
    policy: Policy,
    client: reqwest::Client,
}

/// Why a request was not served.
#[derive(Debug)]
enum Refusal {
    BadId,
    NotFound(String),
    /// Policy violation: the URL, a redirect or a DNS answer is not allowed.
    Blocked(String),
    /// Upstream failed or sent something that is not an acceptable image.
    Upstream(String),
    Internal(String),
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            Refusal::BadId => (StatusCode::BAD_REQUEST, "media id must be a sighting id (integer)".to_string()),
            Refusal::NotFound(m) => (StatusCode::NOT_FOUND, m),
            Refusal::Blocked(m) => (StatusCode::FORBIDDEN, format!("blocked: {m}")),
            Refusal::Upstream(m) => (StatusCode::BAD_GATEWAY, format!("upstream: {m}")),
            Refusal::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        (status, [(header::CACHE_CONTROL, "no-store")], msg).into_response()
    }
}

fn blocked_in_chain(e: &(dyn std::error::Error + 'static)) -> Option<String> {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = cur {
        if let Some(b) = err.downcast_ref::<Blocked>() {
            return Some(b.0.clone());
        }
        cur = err.source();
    }
    None
}

impl MediaProxy {
    pub fn new(policy: Policy) -> MediaProxy {
        let client = reqwest::Client::builder()
            .user_agent("inversa-media-proxy")
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .dns_resolver(Arc::new(policy.resolver.clone()))
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .build()
            .expect("media http client");
        MediaProxy { policy, client }
    }

    /// Fetch `url` under the policy: (sniffed content type, bytes).
    async fn fetch(&self, url: &str) -> Result<(&'static str, Vec<u8>), Refusal> {
        let mut url = Url::parse(url).map_err(|e| Refusal::Blocked(format!("unparseable photo URL: {e}")))?;
        let mut hops = 0;
        let mut res = loop {
            self.policy.check(&url).map_err(Refusal::Blocked)?;
            let res = self.client.get(url.clone()).send().await.map_err(|e| match blocked_in_chain(&e) {
                Some(why) => Refusal::Blocked(why),
                None => Refusal::Upstream(format!("request failed: {e}")),
            })?;
            if !res.status().is_redirection() {
                break res;
            }
            hops += 1;
            if hops > MAX_REDIRECTS {
                return Err(Refusal::Upstream(format!("more than {MAX_REDIRECTS} redirects")));
            }
            let location = res
                .headers()
                .get(header::LOCATION)
                .and_then(|l| l.to_str().ok())
                .ok_or_else(|| Refusal::Upstream(format!("{} without a Location", res.status())))?;
            url = url.join(location).map_err(|e| Refusal::Blocked(format!("bad redirect target: {e}")))?;
        };
        if res.status() != reqwest::StatusCode::OK {
            return Err(Refusal::Upstream(format!("status {}", res.status())));
        }
        let declared = res
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !declared.starts_with("image/") {
            return Err(Refusal::Upstream(format!("content type {declared:?} is not an image")));
        }
        if res.content_length().is_some_and(|n| n > MAX_BYTES as u64) {
            return Err(Refusal::Upstream(format!("image larger than {MAX_BYTES} bytes")));
        }
        let mut body = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|e| Refusal::Upstream(format!("reading body: {e}")))? {
            if body.len() + chunk.len() > MAX_BYTES {
                return Err(Refusal::Upstream(format!("image larger than {MAX_BYTES} bytes")));
            }
            body.extend_from_slice(&chunk);
        }
        let kind = sniff_image(&body).ok_or_else(|| Refusal::Upstream("body is not a JPEG, PNG, GIF or WebP image".into()))?;
        Ok((kind, body))
    }
}

/// A sighting's observation photo, cached under `media/<sighting id>`.
async fn media(state: AppState, Extension(proxy): Extension<Arc<MediaProxy>>, Path((_app, id)): Path<(String, String)>) -> Result<Response, Refusal> {
    let id: i64 = id.parse().map_err(|_| Refusal::BadId)?;
    let key = format!("media/{id}");
    let cached = state.archive.get(&key).await.ok().and_then(|b| sniff_image(&b).map(|kind| (kind, b)));
    let (kind, bytes) = match cached {
        Some(hit) => hit,
        None => {
            let url: Option<Option<String>> = state
                .obs
                .read(move |c| {
                    use rusqlite::OptionalExtension;
                    c.query_row("select photo_url from sightings where id = ?1", [id], |r| r.get(0)).optional()
                })
                .await
                .map_err(|e| Refusal::Internal(format!("{e:#}")))?;
            let url = match url {
                None => return Err(Refusal::NotFound(format!("no sighting {id}"))),
                Some(None) => return Err(Refusal::NotFound(format!("sighting {id} has no photo"))),
                Some(Some(url)) => url,
            };
            let (kind, bytes) = proxy.fetch(&url).await?;
            if let Err(e) = state.archive.put(&key, bytes.clone(), kind).await {
                tracing::warn!("media cache put {key}: {e:#}");
            }
            (kind, bytes)
        }
    };
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(kind)),
            (header::CACHE_CONTROL, HeaderValue::from_static(CACHE_CONTROL)),
            (header::HeaderName::from_static("cross-origin-resource-policy"), HeaderValue::from_static("same-origin")),
            (header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
        ],
        bytes,
    )
        .into_response())
}

pub fn routes() -> Router<AppRegistry> {
    routes_with(Policy::inaturalist())
}

pub fn routes_with(policy: Policy) -> Router<AppRegistry> {
    Router::new()
        .route("/media/{id}", get(media))
        .layer(Extension(Arc::new(MediaProxy::new(policy))))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::app::test_support::test_state;

    const JPEG: &[u8] = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9";

    /// A local upstream standing in for the iNat hosts.
    async fn upstream() -> (SocketAddr, tokio::task::JoinHandle<()>) {
        use axum::response::Redirect;
        let app = Router::new()
            .route("/photo.jpg", get(|| async { ([(header::CONTENT_TYPE, "image/jpeg")], JPEG) }))
            .route("/page", get(|| async { ([(header::CONTENT_TYPE, "text/html")], "<script>alert(1)</script>") }))
            .route("/lying.jpg", get(|| async { ([(header::CONTENT_TYPE, "image/jpeg")], "<html>not an image</html>") }))
            .route("/vector.svg", get(|| async { ([(header::CONTENT_TYPE, "image/svg+xml")], "<svg onload='x()'/>") }))
            .route(
                "/huge.jpg",
                get(|| async {
                    let mut body = JPEG.to_vec();
                    body.resize(MAX_BYTES + 1, 0);
                    ([(header::CONTENT_TYPE, "image/jpeg")], body)
                }),
            )
            .route("/to-evil", get(|| async { Redirect::temporary("http://evil.example.com/photo.jpg") }))
            .route("/to-metadata", get(|| async { Redirect::temporary("http://169.254.169.254/latest/meta-data/") }))
            .route("/to-same-host", get(|| async { Redirect::temporary("/photo.jpg") }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        (addr, tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }))
    }

    /// Allowlist as production, http and explicit ports allowed; `static.inaturalist.org` pinned
    /// to the local upstream (loopback allowed), the S3 host pinned to a private address.
    fn test_policy(port: u16) -> Policy {
        let mut pinned = HashMap::new();
        pinned.insert("static.inaturalist.org".to_string(), vec![SocketAddr::from(([127, 0, 0, 1], port))]);
        pinned.insert("inaturalist-open-data.s3.amazonaws.com".to_string(), vec![SocketAddr::from(([10, 0, 0, 7], port))]);
        Policy {
            hosts: ALLOWED_HOSTS.iter().map(|h| h.to_string()).collect(),
            require_https: false,
            any_port: true,
            resolver: GuardedResolver { pinned, allow_loopback: true },
        }
    }

    async fn sighting_with_photo(state: &AppState, url: String) -> i64 {
        crate::hotspot::score::testkit::seed_sources(&state.obs).await;
        state
            .obs
            .write(move |tx| {
                let ext: i64 = tx.query_row("select coalesce(max(id), 0) + 1 from sightings", [], |r| r.get(0))?;
                tx.execute(
                    "insert into sightings (source_id, ext_id, taxon_id, lat, lon, observed_at, quality, photo_url, ingested_at)
                     values ('inat', ?1, 1, 25.4, -80.6, 0, 'research', ?2, 0)",
                    rusqlite::params![ext.to_string(), url],
                )?;
                Ok(tx.last_insert_rowid())
            })
            .await
            .unwrap()
    }

    async fn get_media(state: &AppState, policy: Policy, id: &str) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let registry = AppRegistry::from_states(vec![state.clone()]);
        let app = Router::new().nest("/v1/{app}", routes_with(policy)).with_state(registry);
        let res = app.oneshot(Request::get(format!("/v1/python/media/{id}")).body(Body::empty()).unwrap()).await.unwrap();
        let (parts, body) = res.into_parts();
        (parts.status, parts.headers, body.collect().await.unwrap().to_bytes().to_vec())
    }

    async fn served(path: &str, host: &str) -> (StatusCode, axum::http::HeaderMap, String, AppState, i64) {
        let (addr, server) = upstream().await;
        let state = test_state();
        let id = sighting_with_photo(&state, format!("http://{host}:{}{path}", addr.port())).await;
        let (status, headers, body) = get_media(&state, test_policy(addr.port()), &id.to_string()).await;
        server.abort();
        (status, headers, String::from_utf8_lossy(&body).into_owned(), state, id)
    }

    /// Only sightings have photos: the taxon photo route (T44) is gone, and a bad id is a 400.
    #[tokio::test]
    async fn media_serves_sighting_photos_only() {
        let state = test_state();
        let (status, _, _) = get_media(&state, Policy::inaturalist(), "taxon/1").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, body) = get_media(&state, Policy::inaturalist(), "x").await;
        assert_eq!((status, String::from_utf8_lossy(&body).as_ref()), (StatusCode::BAD_REQUEST, "media id must be a sighting id (integer)"));
        let (status, _, body) = get_media(&state, Policy::inaturalist(), "999").await;
        assert_eq!((status, String::from_utf8_lossy(&body).as_ref()), (StatusCode::NOT_FOUND, "no sighting 999"));
    }

    #[tokio::test]
    async fn media_allowlisted_photo_is_served_with_corp_and_cached() {
        let (addr, server) = upstream().await;
        let state = test_state();
        let id = sighting_with_photo(&state, format!("http://static.inaturalist.org:{}/photo.jpg", addr.port())).await;
        let (status, headers, body) = get_media(&state, test_policy(addr.port()), &id.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        assert_eq!(body, JPEG);
        assert_eq!(headers["content-type"], "image/jpeg");
        assert_eq!(headers["cross-origin-resource-policy"], "same-origin");
        assert_eq!(headers["cache-control"], "public, max-age=86400");
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(state.archive.get(&format!("media/{id}")).await.unwrap(), JPEG);

        // Served from the archive once the upstream is gone.
        server.abort();
        let _ = server.await;
        let (status, headers, body) = get_media(&state, test_policy(addr.port()), &id.to_string()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, JPEG);
        assert_eq!(headers["cross-origin-resource-policy"], "same-origin");
    }

    #[tokio::test]
    async fn media_rejects_hosts_off_the_allowlist_and_ip_literals() {
        for url in [
            "https://evil.example.com/photo.jpg",
            "https://static.inaturalist.org.evil.example.com/photo.jpg",
            "https://127.0.0.1/photo.jpg",
            "https://[::1]/photo.jpg",
            "https://169.254.169.254/latest/meta-data/",
            "file:///etc/passwd",
            "https://user:pw@static.inaturalist.org/photo.jpg",
        ] {
            let state = test_state();
            let id = sighting_with_photo(&state, url.to_string()).await;
            let (status, _, body) = get_media(&state, Policy::inaturalist(), &id.to_string()).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{url}: {}", String::from_utf8_lossy(&body));
        }
        // Production policy: https only, default port only.
        let p = Policy::inaturalist();
        assert!(p.check(&Url::parse("https://static.inaturalist.org/photos/1/medium.jpg").unwrap()).is_ok());
        assert!(p.check(&Url::parse("https://INATURALIST-OPEN-DATA.s3.amazonaws.com/photos/1/a.jpg").unwrap()).is_ok());
        assert!(p.check(&Url::parse("http://static.inaturalist.org/photos/1/medium.jpg").unwrap()).is_err());
        assert!(p.check(&Url::parse("https://static.inaturalist.org:8443/p.jpg").unwrap()).is_err());
    }

    #[tokio::test]
    async fn media_rejects_allowlisted_names_resolving_to_private_ips() {
        let (status, _, body, _, _) = served("/photo.jpg", "inaturalist-open-data.s3.amazonaws.com").await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(body.contains("no public address"), "{body}");
    }

    #[tokio::test]
    async fn media_rejects_redirects_off_host_and_to_private_ips() {
        let (status, _, body, state, id) = served("/to-evil", "static.inaturalist.org").await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(body.contains("evil.example.com"), "{body}");
        assert!(state.archive.get(&format!("media/{id}")).await.is_err(), "nothing cached");

        let (status, _, body, _, _) = served("/to-metadata", "static.inaturalist.org").await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(body.contains("IP literal"), "{body}");

        // A redirect that stays on an allowlisted host is followed.
        let (status, headers, _, _, _) = served("/to-same-host", "static.inaturalist.org").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["cross-origin-resource-policy"], "same-origin");
    }

    #[tokio::test]
    async fn media_rejects_non_images() {
        for (path, needle) in [
            ("/page", "not an image"),
            ("/vector.svg", "not a JPEG"),
            ("/lying.jpg", "not a JPEG"),
            ("/huge.jpg", "larger than"),
            ("/missing.jpg", "status 404"),
        ] {
            let (status, _, body, _, _) = served(path, "static.inaturalist.org").await;
            assert_eq!(status, StatusCode::BAD_GATEWAY, "{path}: {body}");
            assert!(body.contains(needle), "{path}: {body}");
        }
    }

    #[tokio::test]
    async fn media_unknown_sighting_or_no_photo_is_404() {
        let state = test_state();
        let (status, _, _) = get_media(&state, Policy::inaturalist(), "42").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = get_media(&state, Policy::inaturalist(), "photo.jpg").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        crate::hotspot::score::testkit::seed_sources(&state.obs).await;
        let id = crate::hotspot::score::testkit::insert_sighting(&state.obs, "inat", 1, 25.4, -80.6, 0, "research", None).await;
        let (status, _, body) = get_media(&state, Policy::inaturalist(), &id.to_string()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(String::from_utf8_lossy(&body).contains("no photo"));
    }

    #[test]
    fn media_ip_classification() {
        for ip in ["10.1.2.3", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1",
                   "fe80::1", "fc00::1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::"] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["52.216.1.1", "2606:4700::1111", "::ffff:52.216.1.1"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
        assert_eq!(sniff_image(JPEG), Some("image/jpeg"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"<svg/>"), None);
    }
}
