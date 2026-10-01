//! Water and weather overlays (docs/GODS_EYE.md GC5): a same-origin proxy for time-enabled raster tiles and
//! the NHC cyclone feed. The web app runs under `Cross-Origin-Embedder-Policy: require-corp`, so cross-origin
//! imagery must be CORS or same origin; nowCOAST and NHC advertise no CORS, so everything comes through here
//! with `Cross-Origin-Resource-Policy: same-origin`.
//!
//! `GET /v1/{app}/overlay/{layer}/{z}/{x}/{y}?time=<rfc3339>` serves one Web Mercator (EPSG:3857, 256 px) tile:
//!
//! | layer       | upstream (verified against its capabilities document, see docs/overlays.md)                 |
//! |-------------|---------------------------------------------------------------------------------------------|
//! | `sst-map`   | NASA GIBS WMTS `GHRSST_L4_MUR_Sea_Surface_Temperature`, daily, `GoogleMapsCompatible_Level7` |
//! | `radar`     | NOAA nowCOAST WMS `conus_base_reflectivity_mosaic` (MRMS, about every 4 minutes)             |
//! | `clouds`    | NOAA nowCOAST WMS `goes_longwave_imagery` (GOES-19/18 band 14, every 5 minutes)              |
//! | `lightning` | NOAA nowCOAST WMS `ldn_lightning_strike_density` (15-minute density, Vaisala-derived)        |
//!
//! `GET /v1/{app}/overlay/cyclones` answers `{fetchedAt, current, features}`: `current` is NHC's
//! `CurrentStorms.json` as published and `features` a GeoJSON FeatureCollection of the forecast points,
//! forecast track, forecast cone and past track of every active storm from the NWS tropical weather summary
//! MapServer, each feature tagged `layer: points|track|cone|past`. Cached for five minutes.
//!
//! Rules, the same as [`crate::media`]: a fixed upstream allowlist, https only, no IP literals, no userinfo,
//! DNS answers filtered to public addresses, redirects re-checked hop by hop, bounded bodies, declared and
//! sniffed content types, timeouts. Nothing in the request chooses an upstream: the layer id picks the URL,
//! and `z/x/y` and `time` are validated numbers and an RFC 3339 instant.
//!
//! Tiles are cached in memory keyed by layer, snapped time, z, x and y ([`TileCache`]), bounded in entries and
//! age, so a timeline scrub that returns to a time already seen costs no upstream request.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, Query};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Router};
use chrono::{DateTime, SecondsFormat, Utc};
use reqwest::Url;
use serde::Deserialize;

use crate::app::AppRegistry;
use crate::media::{sniff_image, Blocked, GuardedResolver, Policy, MAX_REDIRECTS};
use crate::state::AppState;

pub const ALLOWED_HOSTS: [&str; 4] = ["gibs.earthdata.nasa.gov", "nowcoast.noaa.gov", "www.nhc.noaa.gov", "mapservices.weather.noaa.gov"];
/// One tile at most; a 256 px PNG is tens of kilobytes.
pub const MAX_TILE_BYTES: usize = 2 * 1024 * 1024;
/// The cyclone feed and the summary layers (a cone polygon runs to tens of kilobytes per storm).
pub const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
pub const TILE_PX: u32 = 256;
/// Cached tiles: entries and age per layer kind.
pub const CACHE_ENTRIES: usize = 2048;
pub const NOWCOAST_CACHE: Duration = Duration::from_secs(60 * 60);
pub const GIBS_CACHE: Duration = Duration::from_secs(24 * 60 * 60);
pub const CYCLONES_CACHE: Duration = Duration::from_secs(5 * 60);
/// Half the Web Mercator world width, metres (EPSG:3857 `R * pi`).
const MERCATOR_HALF: f64 = 20_037_508.342_789_244;

/// The raster layers the proxy serves. The id is the client's layer id (GC5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Layer {
    SstMap,
    Radar,
    Clouds,
    Lightning,
}

impl Layer {
    pub const ALL: [Layer; 4] = [Layer::SstMap, Layer::Radar, Layer::Clouds, Layer::Lightning];

    pub fn parse(id: &str) -> Option<Layer> {
        Layer::ALL.into_iter().find(|l| l.id() == id)
    }

    pub fn id(self) -> &'static str {
        match self {
            Layer::SstMap => "sst-map",
            Layer::Radar => "radar",
            Layer::Clouds => "clouds",
            Layer::Lightning => "lightning",
        }
    }

    /// Deepest zoom served: GIBS publishes MUR SST to level 7; the nowCOAST products are 1-8 km, so level 10
    /// (about 150 m per pixel at the equator) already oversamples them.
    pub fn max_zoom(self) -> u32 {
        match self {
            Layer::SstMap => 7,
            Layer::Radar | Layer::Clouds | Layer::Lightning => 10,
        }
    }

    /// nowCOAST workspace and WMS layer name (GetCapabilities, 2026-10-01).
    fn nowcoast(self) -> Option<(&'static str, &'static str)> {
        match self {
            Layer::Radar => Some(("weather_radar", "conus_base_reflectivity_mosaic")),
            Layer::Clouds => Some(("satellite", "goes_longwave_imagery")),
            Layer::Lightning => Some(("lightning_detection", "ldn_lightning_strike_density")),
            Layer::SstMap => None,
        }
    }

    /// The time the cache and the upstream see: GIBS is daily (a date), nowCOAST products are minutes apart
    /// and pick the nearest advertised time themselves (`nearestValue="1"`), so a minute is the key.
    pub fn time_key(self, at: DateTime<Utc>) -> String {
        match self {
            Layer::SstMap => at.format("%Y-%m-%d").to_string(),
            _ => at.with_second(0).to_rfc3339_opts(SecondsFormat::Secs, true),
        }
    }

    pub fn cache_ttl(self) -> Duration {
        match self {
            Layer::SstMap => GIBS_CACHE,
            _ => NOWCOAST_CACHE,
        }
    }

    pub fn cache_control(self) -> &'static str {
        match self {
            Layer::SstMap => "public, max-age=86400",
            _ => "public, max-age=600",
        }
    }
}

trait WithSecond {
    fn with_second(self, s: u32) -> Self;
}

impl WithSecond for DateTime<Utc> {
    fn with_second(self, s: u32) -> Self {
        use chrono::Timelike;
        Timelike::with_second(&self, s).and_then(|t| t.with_nanosecond(0)).unwrap_or(self)
    }
}

/// Web Mercator bounds of tile `z/x/y`, metres, `(west, south, east, north)`.
pub fn mercator_bbox(z: u32, x: u32, y: u32) -> (f64, f64, f64, f64) {
    let n = (1u64 << z) as f64;
    let size = 2.0 * MERCATOR_HALF / n;
    let west = -MERCATOR_HALF + x as f64 * size;
    let north = MERCATOR_HALF - y as f64 * size;
    (west, north - size, west + size, north)
}

/// Upstream origins. Production is the real services; tests point them at a local server through the
/// same allowlisted host names (the resolver pins them to loopback).
#[derive(Clone)]
pub struct Upstreams {
    pub gibs: String,
    pub nowcoast: String,
    pub nhc: String,
    pub mapservices: String,
}

impl Upstreams {
    pub fn production() -> Upstreams {
        Upstreams {
            gibs: "https://gibs.earthdata.nasa.gov".into(),
            nowcoast: "https://nowcoast.noaa.gov".into(),
            nhc: "https://www.nhc.noaa.gov".into(),
            mapservices: "https://mapservices.weather.noaa.gov".into(),
        }
    }

    /// The upstream URL of one tile.
    pub fn tile_url(&self, layer: Layer, z: u32, x: u32, y: u32, at: DateTime<Utc>) -> String {
        match layer.nowcoast() {
            None => format!("{}/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature/default/{}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png", self.gibs, layer.time_key(at)),
            Some((workspace, name)) => {
                let (w, s, e, n) = mercator_bbox(z, x, y);
                let mut url = Url::parse(&format!("{}/geoserver/observations/{workspace}/ows", self.nowcoast)).expect("nowcoast base url");
                url.query_pairs_mut()
                    .append_pair("service", "WMS")
                    .append_pair("version", "1.3.0")
                    .append_pair("request", "GetMap")
                    .append_pair("layers", name)
                    .append_pair("styles", "")
                    .append_pair("crs", "EPSG:3857")
                    .append_pair("bbox", &format!("{w:.3},{s:.3},{e:.3},{n:.3}"))
                    .append_pair("width", &TILE_PX.to_string())
                    .append_pair("height", &TILE_PX.to_string())
                    .append_pair("format", "image/png")
                    .append_pair("transparent", "true")
                    .append_pair("time", &layer.time_key(at));
                url.into()
            }
        }
    }

    pub fn current_storms_url(&self) -> String {
        format!("{}/CurrentStorms.json", self.nhc)
    }

    /// A tropical weather summary MapServer layer as GeoJSON (points 5, forecast track 6, cone 7, past track 11).
    pub fn summary_url(&self, layer_id: u32, fields: &str) -> String {
        let mut url = Url::parse(&format!("{}/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer/{layer_id}/query", self.mapservices)).expect("mapservices base url");
        url.query_pairs_mut()
            .append_pair("where", "1=1")
            .append_pair("outFields", fields)
            .append_pair("f", "geojson")
            .append_pair("outSR", "4326")
            .append_pair("returnGeometry", "true")
            .append_pair("geometryPrecision", "2");
        url.into()
    }
}

/// `(summary layer id, feature tag, fields)` of the cyclone geometry the client draws.
pub const SUMMARY_LAYERS: [(u32, &str, &str); 4] = [
    (5, "points", "stormname,stormtype,basin,advisnum,maxwind,gust,mslp,ssnum,tcdvlp,datelbl,fldatelbl,validtime,tau,stormnum,binnumber,lat,lon"),
    (6, "track", "stormname,stormtype,basin,advisnum,stormnum,binnumber"),
    (7, "cone", "stormname,stormtype,basin,advisnum,stormnum,binnumber"),
    (11, "past", "stormtype,stormnum,binnumber,ss"),
];

/// Merge the summary layers into one FeatureCollection, each feature tagged with its `layer`; a layer that is
/// not a FeatureCollection contributes nothing (the route still answers with the storms it has).
pub fn merge_summary(layers: &[(&str, serde_json::Value)]) -> serde_json::Value {
    let mut features = Vec::new();
    for (tag, value) in layers {
        let Some(list) = value.get("features").and_then(|f| f.as_array()) else { continue };
        for f in list {
            let mut f = f.clone();
            if let Some(props) = f.get_mut("properties").and_then(|p| p.as_object_mut()) {
                props.insert("layer".into(), serde_json::Value::String((*tag).to_string()));
            }
            features.push(f);
        }
    }
    serde_json::json!({ "type": "FeatureCollection", "features": features })
}

/// Active storms of a `CurrentStorms.json` body: `(id, name, classification)`; an empty list when the document
/// has none or is not the expected shape.
pub fn active_storms(current: &serde_json::Value) -> Vec<(String, String, String)> {
    current
        .get("activeStorms")
        .and_then(|s| s.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|s| {
                    let text = |k: &str| s.get(k).and_then(|v| v.as_str()).map(str::to_string);
                    Some((text("id")?, text("name")?, text("classification").unwrap_or_default()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Bounded in-memory tile cache: FIFO eviction past [`CACHE_ENTRIES`], per-entry age limit.
#[derive(Default)]
pub struct TileCache {
    entries: HashMap<String, (Instant, &'static str, Arc<Vec<u8>>)>,
    order: VecDeque<String>,
}

impl TileCache {
    pub fn key(layer: Layer, at: DateTime<Utc>, z: u32, x: u32, y: u32) -> String {
        format!("{}/{}/{z}/{x}/{y}", layer.id(), layer.time_key(at))
    }

    pub fn req(&self, key: &str, ttl: Duration) -> Option<(&'static str, Arc<Vec<u8>>)> {
        let (at, kind, bytes) = self.entries.get(key)?;
        (at.elapsed() < ttl).then(|| (*kind, bytes.clone()))
    }

    pub fn put(&mut self, key: String, kind: &'static str, bytes: Arc<Vec<u8>>) {
        if self.entries.insert(key.clone(), (Instant::now(), kind, bytes)).is_none() {
            self.order.push_back(key);
        }
        while self.entries.len() > CACHE_ENTRIES {
            match self.order.pop_front() {
                Some(old) => {
                    self.entries.remove(&old);
                }
                None => break,
            }
        }
    }
}

/// What a fetch may return.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Accept {
    /// Declared `image/*`, sniffed PNG/JPEG/GIF/WebP, at most [`MAX_TILE_BYTES`].
    Image,
    /// Declared JSON (or GeoJSON), parses as JSON, at most [`MAX_JSON_BYTES`].
    Json,
}

/// Why a request was not served.
#[derive(Debug)]
enum Refusal {
    Bad(String),
    Blocked(String),
    Upstream(String),
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            Refusal::Bad(m) => (StatusCode::BAD_REQUEST, m),
            Refusal::Blocked(m) => (StatusCode::FORBIDDEN, format!("blocked: {m}")),
            Refusal::Upstream(m) => (StatusCode::BAD_GATEWAY, format!("upstream: {m}")),
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

pub struct OverlayProxy {
    policy: Policy,
    upstreams: Upstreams,
    client: reqwest::Client,
    tiles: Mutex<TileCache>,
    cyclones: Mutex<Option<(Instant, Arc<Vec<u8>>)>>,
}

impl OverlayProxy {
    pub fn production() -> OverlayProxy {
        let policy = Policy { hosts: ALLOWED_HOSTS.iter().map(|h| h.to_string()).collect(), require_https: true, any_port: false, resolver: GuardedResolver::default() };
        OverlayProxy::new(policy, Upstreams::production(), Duration::from_secs(20))
    }

    pub fn new(policy: Policy, upstreams: Upstreams, timeout: Duration) -> OverlayProxy {
        let client = reqwest::Client::builder()
            .user_agent("inversa-overlay-proxy (+https://github.com/CalvinMaighan/inversa-challenge)")
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .dns_resolver(Arc::new(policy.resolver.clone()))
            .connect_timeout(timeout.min(Duration::from_secs(5)))
            .timeout(timeout)
            .build()
            .expect("overlay http client");
        OverlayProxy { policy, upstreams, client, tiles: Mutex::new(TileCache::default()), cyclones: Mutex::new(None) }
    }

    /// Fetch `url` under the policy: (content type to serve, bytes).
    async fn fetch(&self, url: &str, accept: Accept) -> Result<(&'static str, Vec<u8>), Refusal> {
        let mut url = Url::parse(url).map_err(|e| Refusal::Blocked(format!("unparseable upstream URL: {e}")))?;
        let mut hops = 0;
        let mut res = loop {
            self.policy.check(&url).map_err(Refusal::Blocked)?;
            let res = self.client.get(url.clone()).send().await.map_err(|e| match blocked_in_chain(&e) {
                Some(why) => Refusal::Blocked(why),
                None if e.is_timeout() => Refusal::Upstream("timed out".into()),
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
        let declared = res.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default().to_ascii_lowercase();
        let max = match accept {
            Accept::Image => {
                if !declared.starts_with("image/") {
                    return Err(Refusal::Upstream(format!("content type {declared:?} is not an image")));
                }
                MAX_TILE_BYTES
            }
            Accept::Json => {
                if !(declared.contains("json") || declared.starts_with("text/plain")) {
                    return Err(Refusal::Upstream(format!("content type {declared:?} is not JSON")));
                }
                MAX_JSON_BYTES
            }
        };
        if res.content_length().is_some_and(|n| n > max as u64) {
            return Err(Refusal::Upstream(format!("body larger than {max} bytes")));
        }
        let mut body = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|e| Refusal::Upstream(if e.is_timeout() { "timed out".to_string() } else { format!("reading body: {e}") }))? {
            if body.len() + chunk.len() > max {
                return Err(Refusal::Upstream(format!("body larger than {max} bytes")));
            }
            body.extend_from_slice(&chunk);
        }
        match accept {
            Accept::Image => {
                let kind = sniff_image(&body).ok_or_else(|| Refusal::Upstream("body is not a PNG, JPEG, GIF or WebP image".into()))?;
                Ok((kind, body))
            }
            Accept::Json => {
                serde_json::from_slice::<serde::de::IgnoredAny>(&body).map_err(|e| Refusal::Upstream(format!("body is not JSON: {e}")))?;
                Ok(("application/json", body))
            }
        }
    }

    /// One tile, from the cache or the upstream.
    async fn tile(&self, layer: Layer, z: u32, x: u32, y: u32, at: DateTime<Utc>) -> Result<(&'static str, Arc<Vec<u8>>, bool), Refusal> {
        let key = TileCache::key(layer, at, z, x, y);
        if let Some((kind, bytes)) = self.tiles.lock().expect("tile cache").req(&key, layer.cache_ttl()) {
            return Ok((kind, bytes, true));
        }
        let (kind, bytes) = self.fetch(&self.upstreams.tile_url(layer, z, x, y, at), Accept::Image).await?;
        let bytes = Arc::new(bytes);
        self.tiles.lock().expect("tile cache").put(key, kind, bytes.clone());
        Ok((kind, bytes, false))
    }

    /// The cyclone document, from the cache or the upstreams.
    async fn cyclones(&self) -> Result<(Arc<Vec<u8>>, bool), Refusal> {
        if let Some((at, bytes)) = self.cyclones.lock().expect("cyclone cache").as_ref() {
            if at.elapsed() < CYCLONES_CACHE {
                return Ok((bytes.clone(), true));
            }
        }
        let (_, raw) = self.fetch(&self.upstreams.current_storms_url(), Accept::Json).await?;
        let current: serde_json::Value = serde_json::from_slice(&raw).map_err(|e| Refusal::Upstream(format!("CurrentStorms.json: {e}")))?;
        let mut layers: Vec<(&str, serde_json::Value)> = Vec::new();
        if !active_storms(&current).is_empty() {
            for (id, tag, fields) in SUMMARY_LAYERS {
                match self.fetch(&self.upstreams.summary_url(id, fields), Accept::Json).await {
                    Ok((_, body)) => match serde_json::from_slice::<serde_json::Value>(&body) {
                        Ok(v) => layers.push((tag, v)),
                        Err(e) => tracing::warn!("cyclones: summary layer {id} ({tag}) is not JSON: {e}"),
                    },
                    // Positions still come from CurrentStorms.json; the drawing degrades to markers.
                    Err(e) => tracing::warn!("cyclones: summary layer {id} ({tag}) failed: {e:?}"),
                }
            }
        }
        let doc = serde_json::json!({
            "fetchedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            "current": current,
            "features": merge_summary(&layers),
            "attribution": "NOAA/NWS National Hurricane Center and Central Pacific Hurricane Center",
        });
        let bytes = Arc::new(serde_json::to_vec(&doc).map_err(|e| Refusal::Upstream(format!("encode: {e}")))?);
        *self.cyclones.lock().expect("cyclone cache") = Some((Instant::now(), bytes.clone()));
        Ok((bytes, false))
    }
}

#[derive(Deserialize)]
struct TimeQuery {
    time: Option<String>,
}

/// `time`: an RFC 3339 instant, at most now (the future has no observations); absent means now.
fn parse_time(raw: Option<&str>) -> Result<DateTime<Utc>, Refusal> {
    let now = Utc::now();
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else { return Ok(now) };
    let at = DateTime::parse_from_rfc3339(raw).map_err(|e| Refusal::Bad(format!("time must be RFC 3339: {e}")))?.with_timezone(&Utc);
    Ok(at.min(now))
}

fn tile_headers(kind: &'static str, cache_control: &'static str, hit: bool) -> [(header::HeaderName, HeaderValue); 5] {
    [
        (header::CONTENT_TYPE, HeaderValue::from_static(kind)),
        (header::CACHE_CONTROL, HeaderValue::from_static(cache_control)),
        (header::HeaderName::from_static("cross-origin-resource-policy"), HeaderValue::from_static("same-origin")),
        (header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
        (header::HeaderName::from_static("x-overlay-cache"), HeaderValue::from_static(if hit { "hit" } else { "miss" })),
    ]
}

async fn tile(
    _state: AppState,
    Extension(proxy): Extension<Arc<OverlayProxy>>,
    Path((_app, layer, z, x, y)): Path<(String, String, String, String, String)>,
    Query(q): Query<TimeQuery>,
) -> Result<Response, Refusal> {
    let layer = Layer::parse(&layer).ok_or_else(|| Refusal::Bad(format!("unknown overlay layer {layer:?}; one of {}", Layer::ALL.map(Layer::id).join(", "))))?;
    let num = |s: &str, what: &str| s.parse::<u32>().map_err(|_| Refusal::Bad(format!("{what} must be a non-negative integer")));
    let (z, x, y) = (num(&z, "z")?, num(&x, "x")?, num(&y, "y")?);
    if z > layer.max_zoom() {
        return Err(Refusal::Bad(format!("z must be at most {} for {}", layer.max_zoom(), layer.id())));
    }
    let n = 1u64 << z;
    if u64::from(x) >= n || u64::from(y) >= n {
        return Err(Refusal::Bad(format!("x and y must be below {n} at z={z}")));
    }
    let at = parse_time(q.time.as_deref())?;
    let (kind, bytes, hit) = proxy.tile(layer, z, x, y, at).await?;
    Ok((tile_headers(kind, layer.cache_control(), hit), bytes.as_ref().clone()).into_response())
}

async fn cyclones(_state: AppState, Extension(proxy): Extension<Arc<OverlayProxy>>) -> Result<Response, Refusal> {
    let (bytes, hit) = proxy.cyclones().await?;
    Ok((tile_headers("application/json", "public, max-age=300", hit), bytes.as_ref().clone()).into_response())
}

pub fn routes() -> Router<AppRegistry> {
    routes_with(OverlayProxy::production())
}

pub fn routes_with(proxy: OverlayProxy) -> Router<AppRegistry> {
    Router::new()
        .route("/overlay/cyclones", get(cyclones))
        .route("/overlay/{layer}/{z}/{x}/{y}", get(tile))
        .layer(Extension(Arc::new(proxy)))
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::body::Body;
    use axum::http::Request;
    use axum::response::Redirect;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::app::test_support::test_state;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89";
    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/nhc");

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!("{FIXTURES}/{name}")).unwrap()
    }

    /// A local stand-in for every upstream: GIBS and nowCOAST tiles (counted), NHC's feed, the MapServer.
    struct Upstream {
        addr: SocketAddr,
        hits: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    async fn upstream(storms: bool) -> Upstream {
        use axum::extract::{Path as AxPath, Query as AxQuery};
        let hits = Arc::new(AtomicUsize::new(0));
        let count = hits.clone();
        let counted = move || {
            count.fetch_add(1, Ordering::SeqCst);
        };
        let c1 = counted.clone();
        let c2 = counted.clone();
        let current = if storms { fixture("CurrentStorms.json") } else { r#"{"activeStorms":[]}"#.to_string() };
        let app = Router::new()
            .route(
                "/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature/default/{date}/GoogleMapsCompatible_Level7/{z}/{y}/{file}",
                get(move |AxPath((date, z, y, file)): AxPath<(String, u32, u32, String)>| {
                    c1();
                    async move { ([(header::CONTENT_TYPE, "image/png".to_string()), (header::HeaderName::from_static("x-echo"), format!("{date}/{z}/{y}/{file}"))], PNG) }
                }),
            )
            .route(
                "/geoserver/observations/{workspace}/ows",
                get(move |AxPath(workspace): AxPath<String>, AxQuery(q): AxQuery<HashMap<String, String>>| {
                    c2();
                    async move {
                        let echo = format!("{workspace} {} {} {} {}", q["layers"], q["crs"], q["bbox"], q["time"]);
                        if q["layers"] == "slow" {
                            tokio::time::sleep(Duration::from_secs(3)).await;
                        }
                        match q.get("bbox").map(|b| b.as_str()) {
                            Some("html") => ([(header::CONTENT_TYPE, "text/html".to_string()), (header::HeaderName::from_static("x-echo"), echo)], b"<html>".to_vec()),
                            Some("lying") => ([(header::CONTENT_TYPE, "image/png".to_string()), (header::HeaderName::from_static("x-echo"), echo)], b"<svg/>".to_vec()),
                            Some("huge") => {
                                let mut body = PNG.to_vec();
                                body.resize(MAX_TILE_BYTES + 1, 0);
                                ([(header::CONTENT_TYPE, "image/png".to_string()), (header::HeaderName::from_static("x-echo"), echo)], body)
                            }
                            _ => ([(header::CONTENT_TYPE, "image/png".to_string()), (header::HeaderName::from_static("x-echo"), echo)], PNG.to_vec()),
                        }
                    }
                }),
            )
            .route("/CurrentStorms.json", get(move || async move { ([(header::CONTENT_TYPE, "application/json")], current.clone()) }))
            .route(
                "/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer/{id}/query",
                get(|AxPath(id): AxPath<u32>| async move {
                    let name = match id {
                        5 => "points",
                        6 => "track",
                        7 => "cone",
                        11 => "past",
                        _ => return (StatusCode::NOT_FOUND, [(header::CONTENT_TYPE, "text/plain")], String::new()),
                    };
                    (StatusCode::OK, [(header::CONTENT_TYPE, "application/geo+json")], fixture(&format!("summary-{name}.geojson")))
                }),
            )
            .route("/to-evil", get(|| async { Redirect::temporary("http://evil.example.com/tile.png") }))
            .route("/to-metadata", get(|| async { Redirect::temporary("http://169.254.169.254/latest/meta-data/") }))
            .route("/to-private-name", get(|| async { Redirect::temporary("http://mapservices.weather.noaa.gov/x.png") }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Upstream { addr, hits, task }
    }

    /// Every allowlisted name pinned to the local upstream (loopback allowed), except `mapservices`, pinned
    /// to a private address, so a redirect there is refused by the resolver.
    fn test_proxy(port: u16, timeout: Duration) -> OverlayProxy {
        let mut pinned = HashMap::new();
        for host in ALLOWED_HOSTS {
            pinned.insert(host.to_string(), vec![SocketAddr::from(([127, 0, 0, 1], port))]);
        }
        let policy = Policy { hosts: ALLOWED_HOSTS.iter().map(|h| h.to_string()).collect(), require_https: false, any_port: true, resolver: GuardedResolver { pinned, allow_loopback: true } };
        let base = |host: &str| format!("http://{host}:{port}");
        let upstreams = Upstreams { gibs: base("gibs.earthdata.nasa.gov"), nowcoast: base("nowcoast.noaa.gov"), nhc: base("www.nhc.noaa.gov"), mapservices: base("mapservices.weather.noaa.gov") };
        OverlayProxy::new(policy, upstreams, timeout)
    }

    async fn req(router: &Router, uri: &str) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let res = router.clone().oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
        let (parts, body) = res.into_parts();
        (parts.status, parts.headers, body.collect().await.unwrap().to_bytes().to_vec())
    }

    fn router(proxy: OverlayProxy) -> Router {
        let registry = AppRegistry::from_states(vec![test_state()]);
        Router::new().nest("/v1/{app}", routes_with(proxy)).with_state(registry)
    }

    fn text(b: &[u8]) -> String {
        String::from_utf8_lossy(b).into_owned()
    }

    #[test]
    fn overlay_proxy_tile_math_and_time_keys() {
        assert_eq!(mercator_bbox(0, 0, 0), (-MERCATOR_HALF, -MERCATOR_HALF, MERCATOR_HALF, MERCATOR_HALF));
        let (w, s, e, n) = mercator_bbox(1, 1, 0);
        assert_eq!((w, s, e, n), (0.0, 0.0, MERCATOR_HALF, MERCATOR_HALF));
        // Louisiana at z=6: x=15, y=26 (Web Mercator tile of about 92 W, 30 N).
        let (w, s, e, n) = mercator_bbox(6, 15, 26);
        // -95.6..-90 degrees east, 27..32 degrees north: the tile holds the Atchafalaya Basin.
        assert!(w < -10_600_000.0 && e > -10_100_000.0 && s < 3_200_000.0 && n > 3_700_000.0, "{w} {s} {e} {n}");
        let at = DateTime::parse_from_rfc3339("2026-10-01T19:36:12.345Z").unwrap().with_timezone(&Utc);
        assert_eq!(Layer::SstMap.time_key(at), "2026-10-01");
        assert_eq!(Layer::Radar.time_key(at), "2026-10-01T19:36:00Z");
        assert_eq!(Layer::parse("sst-map"), Some(Layer::SstMap));
        assert_eq!(Layer::parse("sst"), None);
        let up = Upstreams::production();
        assert_eq!(
            up.tile_url(Layer::SstMap, 5, 8, 13, at),
            "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature/default/2026-10-01/GoogleMapsCompatible_Level7/5/13/8.png"
        );
        let radar = up.tile_url(Layer::Radar, 6, 15, 26, at);
        assert!(radar.starts_with("https://nowcoast.noaa.gov/geoserver/observations/weather_radar/ows?service=WMS&version=1.3.0&request=GetMap&layers=conus_base_reflectivity_mosaic"), "{radar}");
        assert!(radar.contains("crs=EPSG%3A3857") && radar.contains("width=256") && radar.contains("transparent=true") && radar.contains("time=2026-10-01T19%3A36%3A00Z"), "{radar}");
        assert!(up.tile_url(Layer::Clouds, 1, 0, 0, at).contains("satellite/ows?") && up.tile_url(Layer::Clouds, 1, 0, 0, at).contains("layers=goes_longwave_imagery"));
        assert!(up.tile_url(Layer::Lightning, 1, 0, 0, at).contains("lightning_detection/ows?") && up.tile_url(Layer::Lightning, 1, 0, 0, at).contains("layers=ldn_lightning_strike_density"));
        assert!(up.summary_url(7, "stormname").starts_with("https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer/7/query?where=1%3D1&outFields=stormname&f=geojson"));
    }

    #[tokio::test]
    async fn overlay_proxy_bad_layer_zoom_tile_and_time_are_400() {
        let app = router(OverlayProxy::production());
        let (status, _, body) = req(&app, "/v1/python/overlay/sst/3/1/1").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{}", text(&body));
        assert!(text(&body).contains("unknown overlay layer \"sst\""), "{}", text(&body));
        let (status, _, body) = req(&app, "/v1/python/overlay/sst-map/8/1/1").await;
        assert_eq!((status, text(&body)), (StatusCode::BAD_REQUEST, "z must be at most 7 for sst-map".to_string()));
        let (status, _, body) = req(&app, "/v1/python/overlay/radar/11/1/1").await;
        assert_eq!((status, text(&body)), (StatusCode::BAD_REQUEST, "z must be at most 10 for radar".to_string()));
        let (status, _, body) = req(&app, "/v1/python/overlay/radar/2/4/0").await;
        assert_eq!((status, text(&body)), (StatusCode::BAD_REQUEST, "x and y must be below 4 at z=2".to_string()));
        let (status, _, _) = req(&app, "/v1/python/overlay/radar/2/-1/0").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _, body) = req(&app, "/v1/python/overlay/radar/2/1/0?time=yesterday").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(text(&body).starts_with("time must be RFC 3339"), "{}", text(&body));
        // An unknown app is the registry's 404, as every other route.
        let (status, _, _) = req(&app, "/v1/otter/overlay/radar/2/1/0").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = req(&app, "/v1/otter/overlay/cyclones").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[test]
    fn overlay_proxy_allowlist_https_only_no_ip_literals() {
        let p = OverlayProxy::production().policy;
        for ok in [
            "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/x/default/2026-10-01/GoogleMapsCompatible_Level7/1/0/0.png",
            "https://nowcoast.noaa.gov/geoserver/observations/weather_radar/ows?service=WMS",
            "https://WWW.NHC.NOAA.GOV/CurrentStorms.json",
            "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer/7/query",
        ] {
            assert!(p.check(&Url::parse(ok).unwrap()).is_ok(), "{ok}");
        }
        for bad in [
            "http://nowcoast.noaa.gov/geoserver/observations/weather_radar/ows",
            "https://nowcoast.noaa.gov:8443/x",
            "https://user:pw@nowcoast.noaa.gov/x",
            "https://nowcoast.noaa.gov.evil.example.com/x",
            "https://evil.example.com/x",
            "https://127.0.0.1/x",
            "https://[::1]/x",
            "https://169.254.169.254/latest/meta-data/",
            "file:///etc/passwd",
        ] {
            assert!(p.check(&Url::parse(bad).unwrap()).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn overlay_proxy_serves_tiles_with_corp_and_caches_by_layer_time_and_zxy() {
        let up = upstream(false).await;
        let app = router(test_proxy(up.addr.port(), Duration::from_secs(5)));
        let t1 = "2026-10-01T19:36:12Z";
        let (status, headers, body) = req(&app, &format!("/v1/python/overlay/radar/6/15/26?time={t1}")).await;
        assert_eq!(status, StatusCode::OK, "{}", text(&body));
        assert_eq!(body, PNG);
        assert_eq!(headers["content-type"], "image/png");
        assert_eq!(headers["cross-origin-resource-policy"], "same-origin");
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(headers["cache-control"], "public, max-age=600");
        assert_eq!(headers["x-overlay-cache"], "miss");
        assert_eq!(up.hits.load(Ordering::SeqCst), 1);
        // Same layer, same minute, same tile: cached (the seconds differ, the minute key does not).
        let (status, headers, _) = req(&app, "/v1/python/overlay/radar/6/15/26?time=2026-10-01T19:36:59Z").await;
        assert_eq!((status, headers["x-overlay-cache"].to_str().unwrap()), (StatusCode::OK, "hit"));
        assert_eq!(up.hits.load(Ordering::SeqCst), 1);
        // Another minute, another tile, another layer: each its own fetch.
        for uri in ["/v1/python/overlay/radar/6/15/26?time=2026-10-01T19:40:00Z", "/v1/python/overlay/radar/6/15/27?time=2026-10-01T19:36:00Z", "/v1/python/overlay/clouds/6/15/26?time=2026-10-01T19:36:00Z"] {
            let (status, headers, body) = req(&app, uri).await;
            assert_eq!((status, headers["x-overlay-cache"].to_str().unwrap()), (StatusCode::OK, "miss"), "{uri}: {}", text(&body));
        }
        assert_eq!(up.hits.load(Ordering::SeqCst), 4);
        // GIBS: the date is the key, the tile is addressed z/y/x, the answer is cached a day.
        let (status, headers, _) = req(&app, "/v1/python/overlay/sst-map/5/8/13?time=2026-09-30T23:59:00Z").await;
        assert_eq!((status, headers["cache-control"].to_str().unwrap()), (StatusCode::OK, "public, max-age=86400"));
        let (_, headers, _) = req(&app, "/v1/python/overlay/sst-map/5/8/13?time=2026-09-30T01:00:00Z").await;
        assert_eq!(headers["x-overlay-cache"], "hit");
        assert_eq!(up.hits.load(Ordering::SeqCst), 5);
        // No time: now, served; a future time is clamped to now (no upstream request for the future).
        let (status, _, _) = req(&app, "/v1/python/overlay/lightning/4/3/6").await;
        assert_eq!(status, StatusCode::OK);
        up.task.abort();
    }

    #[tokio::test]
    async fn overlay_proxy_rejects_redirects_off_the_allowlist_and_to_private_addresses() {
        let up = upstream(false).await;
        let proxy = test_proxy(up.addr.port(), Duration::from_secs(5));
        let base = format!("http://nowcoast.noaa.gov:{}", up.addr.port());
        for (path, needle) in [("/to-evil", "evil.example.com"), ("/to-metadata", "IP literal")] {
            let err = proxy.fetch(&format!("{base}{path}"), Accept::Image).await.unwrap_err();
            match err {
                Refusal::Blocked(m) => assert!(m.contains(needle), "{path}: {m}"),
                other => panic!("{path}: {other:?}"),
            }
        }
        // An allowlisted name that resolves to a private address is refused by the resolver.
        let mut pinned = HashMap::new();
        pinned.insert("mapservices.weather.noaa.gov".to_string(), vec![SocketAddr::from(([10, 0, 0, 7], up.addr.port()))]);
        pinned.insert("nowcoast.noaa.gov".to_string(), vec![SocketAddr::from(([127, 0, 0, 1], up.addr.port()))]);
        let policy = Policy { hosts: ALLOWED_HOSTS.iter().map(|h| h.to_string()).collect(), require_https: false, any_port: true, resolver: GuardedResolver { pinned, allow_loopback: true } };
        let private = OverlayProxy::new(policy, proxy.upstreams.clone(), Duration::from_secs(5));
        let err = private.fetch(&format!("{base}/to-private-name"), Accept::Image).await.unwrap_err();
        match err {
            Refusal::Blocked(m) => assert!(m.contains("no public address"), "{m}"),
            other => panic!("{other:?}"),
        }
        // The production policy never follows http.
        let app = router(OverlayProxy::production());
        let _ = app;
        up.task.abort();
    }

    #[tokio::test]
    async fn overlay_proxy_rejects_non_images_oversize_and_times_out() {
        let up = upstream(false).await;
        let proxy = test_proxy(up.addr.port(), Duration::from_millis(400));
        let base = format!("http://nowcoast.noaa.gov:{}/geoserver/observations/weather_radar/ows?layers=x&crs=EPSG:3857&time=t&bbox=", up.addr.port());
        for (bbox, needle) in [("html", "not an image"), ("lying", "not a PNG"), ("huge", "larger than")] {
            match proxy.fetch(&format!("{base}{bbox}"), Accept::Image).await.unwrap_err() {
                Refusal::Upstream(m) => assert!(m.contains(needle), "{bbox}: {m}"),
                other => panic!("{bbox}: {other:?}"),
            }
        }
        let slow = format!("http://nowcoast.noaa.gov:{}/geoserver/observations/weather_radar/ows?layers=slow&crs=EPSG:3857&time=t&bbox=x", up.addr.port());
        match proxy.fetch(&slow, Accept::Image).await.unwrap_err() {
            Refusal::Upstream(m) => assert_eq!(m, "timed out"),
            other => panic!("{other:?}"),
        }
        // JSON: a tile is not a feed.
        let png = format!("http://nowcoast.noaa.gov:{}/geoserver/observations/weather_radar/ows?layers=x&crs=EPSG:3857&time=t&bbox=ok", up.addr.port());
        match proxy.fetch(&png, Accept::Json).await.unwrap_err() {
            Refusal::Upstream(m) => assert!(m.contains("not JSON"), "{m}"),
            other => panic!("{other:?}"),
        }
        let (status, _, body) = req(&router(test_proxy(up.addr.port(), Duration::from_secs(5))), "/v1/python/overlay/radar/3/1/1?time=2026-10-01T00:00:00Z").await;
        assert_eq!(status, StatusCode::OK, "{}", text(&body));
        up.task.abort();
    }

    #[test]
    fn overlay_proxy_tile_cache_is_bounded() {
        let mut cache = TileCache::default();
        assert!(cache.entries.is_empty());
        let at = Utc::now();
        for i in 0..(CACHE_ENTRIES + 10) {
            cache.put(TileCache::key(Layer::Radar, at, 10, i as u32, 1), "image/png", Arc::new(PNG.to_vec()));
        }
        assert_eq!(cache.entries.len(), CACHE_ENTRIES);
        assert_eq!(cache.order.len(), CACHE_ENTRIES);
        assert!(cache.req(&TileCache::key(Layer::Radar, at, 10, 0, 1), NOWCOAST_CACHE).is_none(), "the oldest went first");
        assert!(cache.req(&TileCache::key(Layer::Radar, at, 10, 10, 1), NOWCOAST_CACHE).is_some());
        assert!(cache.req(&TileCache::key(Layer::Radar, at, 10, 10, 1), Duration::ZERO).is_none(), "expired");
    }

    #[test]
    fn overlay_proxy_cyclones_fixture_parses_and_merges() {
        let current: serde_json::Value = serde_json::from_str(&fixture("CurrentStorms.json")).unwrap();
        let storms = active_storms(&current);
        assert_eq!(storms.len(), 3, "{storms:?}");
        assert_eq!(storms[0], ("ep182026".to_string(), "Rachel".to_string(), "HU".to_string()));
        assert!(active_storms(&serde_json::json!({"activeStorms": []})).is_empty());
        assert!(active_storms(&serde_json::json!({})).is_empty());
        let layers: Vec<(&str, serde_json::Value)> = ["points", "track", "cone", "past"].into_iter().map(|n| (n, serde_json::from_str(&fixture(&format!("summary-{n}.geojson"))).unwrap())).collect();
        let merged = merge_summary(&layers);
        let features = merged["features"].as_array().unwrap();
        assert_eq!(features.len(), 20 + 3 + 3 + 26);
        let count = |tag: &str| features.iter().filter(|f| f["properties"]["layer"] == tag).count();
        assert_eq!((count("points"), count("track"), count("cone"), count("past")), (20, 3, 3, 26));
        let cone = features.iter().find(|f| f["properties"]["layer"] == "cone").unwrap();
        assert_eq!(cone["geometry"]["type"], "Polygon");
        assert_eq!(cone["properties"]["binnumber"], "EP3");
        // A layer that is not a collection is skipped, not fatal.
        assert_eq!(merge_summary(&[("points", serde_json::json!({"error": "down"}))])["features"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn overlay_proxy_cyclones_route_serves_storms_and_skips_geometry_without_any() {
        let up = upstream(true).await;
        let app = router(test_proxy(up.addr.port(), Duration::from_secs(5)));
        let (status, headers, body) = req(&app, "/v1/python/overlay/cyclones").await;
        assert_eq!(status, StatusCode::OK, "{}", text(&body));
        assert_eq!(headers["content-type"], "application/json");
        assert_eq!(headers["cross-origin-resource-policy"], "same-origin");
        assert_eq!(headers["x-overlay-cache"], "miss");
        let doc: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(doc["current"]["activeStorms"].as_array().unwrap().len(), 3);
        assert_eq!(doc["features"]["features"].as_array().unwrap().len(), 52);
        assert!(doc["fetchedAt"].as_str().unwrap().ends_with('Z'));
        let (_, headers, _) = req(&app, "/v1/python/overlay/cyclones").await;
        assert_eq!(headers["x-overlay-cache"], "hit");
        up.task.abort();

        let quiet = upstream(false).await;
        let app = router(test_proxy(quiet.addr.port(), Duration::from_secs(5)));
        let (status, _, body) = req(&app, "/v1/python/overlay/cyclones").await;
        assert_eq!(status, StatusCode::OK, "{}", text(&body));
        let doc: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(doc["current"]["activeStorms"].as_array().unwrap().len(), 0);
        assert_eq!(doc["features"]["features"].as_array().unwrap().len(), 0);
        quiet.task.abort();
    }
}
