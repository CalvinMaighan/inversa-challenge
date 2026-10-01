//! GOES-19 NODD push via SNS `NewGOES19Object` to our SQS queue (T7, PRD section 6).
//!
//! `fetch` long-polls the queue (20 s, up to 10 messages) with a hand-signed SigV4 request to the
//! SQS JSON protocol (same HTTPS endpoint as the Query API, JSON in and out, no XML parser). Each
//! message is an SNS notification wrapping an S3 `ObjectCreated` event. Objects of the four products
//! are downloaded from the public bucket and returned as payloads whose `ack` is the receipt handle;
//! `ack` deletes the message after the rows commit. Messages that carry no wanted object are
//! deleted at once. Undeliverable downloads are left on the queue for the visibility timeout to redeliver.
//!
//! Enabled only when `GOES_SQS_URL` (or the app's `GOES_SQS_URL_<APP>`), `AWS_ACCESS_KEY_ID` and
//! `AWS_SECRET_ACCESS_KEY` are set (PLAN C13). Each app listing `goes19` runs its own consumer
//! over its own regions; the feed's `params.products` (ABI product prefixes) narrows which
//! objects it takes, so Lionfish Watch decodes SSTF only while the python app takes all four.

#[path = "goes/decode.rs"]
pub mod decode;

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::app::config::App;
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::Row;
use crate::state::Config;
use decode::Product;

pub const SOURCE_ID: &str = "goes19";
/// The same consumer registered for SST only (Lionfish Watch, L4): its own feed id so `/health`
/// and the feed chips name what it carries.
pub const SST_SOURCE_ID: &str = "goes19-sst";

/// The GOES feed id `app` lists (`goes19` or `goes19-sst`), if any.
pub fn feed_id(app: &App) -> Option<&'static str> {
    [SOURCE_ID, SST_SOURCE_ID].into_iter().find(|id| app.cfg.has_feed(id))
}
pub const BUCKET_URL: &str = "https://noaa-goes19.s3.amazonaws.com/";
const WAIT_SECONDS: u32 = 20;
const MAX_MESSAGES: u32 = 10;

pub fn sources(config: &Config, app: &Arc<App>) -> Vec<Arc<dyn Source>> {
    match configure(config, app) {
        Ok(s) => vec![Arc::new(s)],
        Err(_) => vec![],
    }
}

/// The SQS source for `app`'s regions, or why it cannot run (the reason becomes the feed-state note).
pub fn configure(config: &Config, app: &Arc<App>) -> std::result::Result<GoesSqs, String> {
    match (config.goes_sqs_url_for(app.id()), &config.aws_access_key_id, &config.aws_secret_access_key) {
        (Some(url), Some(key), Some(secret)) => {
            GoesSqs::new(url, key, secret, app.clone()).map_err(|e| format!("GOES_SQS_URL rejected: {e:#}"))
        }
        (url, key, secret) => {
            let missing: Vec<&str> =
                [("GOES_SQS_URL", url.is_none()), ("AWS_ACCESS_KEY_ID", key.is_none()), ("AWS_SECRET_ACCESS_KEY", secret.is_none())]
                    .into_iter()
                    .filter_map(|(k, absent)| absent.then_some(k))
                    .collect();
            Err(format!("{} not set", missing.join(", ")))
        }
    }
}

/// Static description, shared by the running source and its disabled registration.
pub fn info() -> SourceInfo {
    SourceInfo {
        id: SOURCE_ID,
        name: "GOES-19 ABI L2 (NOAA NODD)",
        homepage: "https://registry.opendata.aws/noaa-goes/",
        mode: Mode::Push,
        cadence: Duration::from_secs(3600),
        max_latency: Duration::from_secs(2 * 3600),
    }
}

/// The description under the id `app`'s config lists: `goes19-sst` names the SST-only form.
pub fn info_for(app: &App) -> SourceInfo {
    match feed_id(app) {
        Some(SST_SOURCE_ID) => SourceInfo { id: SST_SOURCE_ID, name: "GOES-19 ABI L2 SST full disk (NOAA NODD)", ..info() },
        _ => info(),
    }
}

/// ABI product prefixes the app's GOES feed takes (`params.products`); empty = every product,
/// except that `goes19-sst` defaults to `ABI-L2-SSTF`.
pub fn products(app: &App) -> Vec<String> {
    let id = feed_id(app).unwrap_or(SOURCE_ID);
    let listed: Vec<String> = app
        .cfg
        .feed(id)
        .and_then(|f| f.params.get("products"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|p| p.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if listed.is_empty() && id == SST_SOURCE_ID {
        return vec!["ABI-L2-SSTF".to_string()];
    }
    listed
}

/// `wanted`, narrowed to the app's product list.
pub fn wanted_for(app: &App, key: &str) -> Option<Product> {
    let product = wanted(key)?;
    let listed = products(app);
    (listed.is_empty() || listed.iter().any(|p| p == product.prefix())).then_some(product)
}

/// Pure: one ABI L2 object (its bucket URL or key names the product) to rows for `app`'s
/// regions. Used by the SQS source and by fixture/archive replay, which has no queue. A product
/// the app's feed does not list yields no rows (the replay of a shared fixture set).
pub fn normalize_object(raw: &RawPayload, app: &App) -> Result<Vec<Row>> {
    let key = raw.source_url.strip_prefix(BUCKET_URL).unwrap_or(&raw.source_url);
    let product = Product::from_key(key).ok_or_else(|| anyhow!("not a GOES product key: {key}"))?;
    let listed = products(app);
    if !listed.is_empty() && !listed.iter().any(|p| p == product.prefix()) {
        tracing::info!(app = app.id(), key = %key, "goes object skipped: product not in the app's feed");
        return Ok(Vec::new());
    }
    let decoded = decode::decode_bytes(&raw.bytes, product, app)?;
    let rows = decode::rows(&decoded, app);
    let windows: Vec<String> = decoded.windows.iter().map(|w| format!("x {}..{} y {}..{}", w.x0, w.x1, w.y0, w.y1)).collect();
    tracing::info!(
        app = app.id(),
        key = %key,
        rows_in = rows.len(),
        observed_at = decoded.observed_at,
        windows = %windows.join("; "),
        "goes object decoded"
    );
    Ok(rows)
}

pub struct GoesSqs {
    app: Arc<App>,
    queue_url: String,
    /// `https://sqs.<region>.amazonaws.com/`
    endpoint: String,
    host: String,
    region: String,
    key_id: String,
    secret: String,
}

impl GoesSqs {
    pub fn new(queue_url: &str, key_id: &str, secret: &str, app: Arc<App>) -> Result<Self> {
        let rest = queue_url.strip_prefix("https://").ok_or_else(|| anyhow!("queue url must be https"))?;
        let host = rest.split('/').next().unwrap_or_default().to_string();
        let parts: Vec<&str> = host.split('.').collect();
        // sqs.<region>.amazonaws.com, or the legacy queue.amazonaws.com (us-east-1).
        let region = match parts.as_slice() {
            ["sqs", region, "amazonaws", "com"] => region.to_string(),
            ["queue", "amazonaws", "com"] => "us-east-1".to_string(),
            _ => bail!("unrecognised SQS host {host}"),
        };
        Ok(GoesSqs {
            app,
            queue_url: queue_url.to_string(),
            endpoint: format!("https://{host}/"),
            host,
            region,
            key_id: key_id.to_string(),
            secret: secret.to_string(),
        })
    }

    /// One SQS JSON-protocol call. Errors carry the HTTP status and the `__type` from the body.
    async fn call(&self, http: &reqwest::Client, action: &str, body: Value) -> Result<Value> {
        let payload = serde_json::to_vec(&body)?;
        let now = Utc::now();
        let target = format!("AmazonSQS.{action}");
        let headers = [
            ("content-type", "application/x-amz-json-1.0"),
            ("host", self.host.as_str()),
            ("x-amz-date", &now.format(AMZ_DATE).to_string()),
            ("x-amz-target", &target),
        ];
        let auth = sigv4(&SignInput {
            method: "POST",
            path: "/",
            query: "",
            headers: &headers,
            payload: &payload,
            now,
            region: &self.region,
            service: "sqs",
            key_id: &self.key_id,
            secret: &self.secret,
        });
        let res = http
            .post(&self.endpoint)
            .header("content-type", headers[0].1)
            .header("x-amz-date", headers[2].1)
            .header("x-amz-target", headers[3].1)
            .header("authorization", auth)
            .body(payload)
            .send()
            .await
            .with_context(|| format!("sqs {action}"))?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            let kind = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v["__type"].as_str().map(str::to_string))
                .unwrap_or_else(|| text.chars().take(200).collect());
            bail!("sqs {action}: HTTP {status} {kind}");
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).with_context(|| format!("sqs {action}: non-JSON body"))
    }

    async fn download_all(&self, http: &reqwest::Client, keys: &[(String, Product)], receipt: &str) -> Result<Vec<RawPayload>> {
        let mut out = Vec::with_capacity(keys.len());
        for (key, product) in keys {
            let url = format!("{BUCKET_URL}{key}");
            let fetched_at = Utc::now().timestamp_millis();
            let res = http.get(&url).send().await.with_context(|| format!("GET {url}"))?;
            let status = res.status().as_u16();
            if !res.status().is_success() {
                bail!("GET {url}: HTTP {status}");
            }
            let bytes = res.bytes().await.with_context(|| format!("GET {url}"))?.to_vec();
            tracing::info!(key = %key, product = ?product, bytes = bytes.len(), "goes object fetched");
            out.push(RawPayload {
                source_url: url,
                content_type: "application/x-netcdf".into(),
                bytes,
                http_status: Some(status),
                fetched_at,
                next_cursor: None,
                ack: Some(receipt.to_string()),
            });
        }
        Ok(out)
    }

    async fn delete(&self, http: &reqwest::Client, receipt: &str) -> Result<()> {
        self.call(http, "DeleteMessage", json!({ "QueueUrl": self.queue_url, "ReceiptHandle": receipt })).await?;
        Ok(())
    }
}

/// A received message reduced to what the consumer needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub receipt: String,
    pub keys: Vec<String>,
}

/// Messages from a `ReceiveMessage` response. Bodies that are not SNS/S3 JSON yield no keys
/// (the caller deletes them) and are logged.
pub fn parse_receive(res: &Value) -> Vec<Message> {
    let Some(msgs) = res.get("Messages").and_then(Value::as_array) else { return vec![] };
    msgs.iter()
        .filter_map(|m| {
            let receipt = m["ReceiptHandle"].as_str()?.to_string();
            let body = m["Body"].as_str().unwrap_or_default();
            let keys = keys_from_body(body).unwrap_or_else(|e| {
                tracing::warn!("goes sqs: unparseable message {}: {e:#}", m["MessageId"]);
                vec![]
            });
            Some(Message { receipt, keys })
        })
        .collect()
}

/// Object keys in one message body: an SNS `Notification` whose `Message` is an S3 event, or (raw
/// delivery on) the S3 event itself. NODD keys contain only `[A-Za-z0-9/_.-]`, so the S3 URL
/// encoding of the key is the identity.
pub fn keys_from_body(body: &str) -> Result<Vec<String>> {
    let outer: Value = serde_json::from_str(body).context("message body")?;
    let event: Value = match outer.get("Message").and_then(Value::as_str) {
        Some(inner) => serde_json::from_str(inner).context("SNS Message")?,
        None => outer,
    };
    let records = event.get("Records").and_then(Value::as_array).ok_or_else(|| anyhow!("no Records"))?;
    Ok(records
        .iter()
        .filter(|r| r["eventName"].as_str().is_none_or(|n| n.starts_with("ObjectCreated")))
        .filter_map(|r| r["s3"]["object"]["key"].as_str().map(str::to_string))
        .collect())
}

/// Products we act on. ACMC arrives every 5 minutes; only the scan starting in the first five
/// minutes of the hour is taken, which is the scan LSTC shares (both start at :01), so cloud flags
/// line up with the hourly LST field instead of writing a cloud mask twelve times an hour.
pub fn wanted(key: &str) -> Option<Product> {
    let product = Product::from_key(key)?;
    if product == Product::Acm && scan_start_minute(key).is_none_or(|m| m >= 5) {
        return None;
    }
    Some(product)
}

/// Minute of the `_sYYYYDDDHHMMSSt` scan-start field in an ABI file name.
fn scan_start_minute(key: &str) -> Option<u32> {
    let i = key.find("_s")? + 2;
    key.get(i + 9..i + 11)?.parse().ok()
}

#[async_trait]
impl Source for GoesSqs {
    fn info(&self) -> SourceInfo {
        info_for(&self.app)
    }

    fn min_interval(&self) -> Duration {
        Duration::ZERO
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> Result<Vec<RawPayload>> {
        let http = &ctx.state.http;
        let res = self
            .call(
                http,
                "ReceiveMessage",
                json!({ "QueueUrl": self.queue_url, "MaxNumberOfMessages": MAX_MESSAGES, "WaitTimeSeconds": WAIT_SECONDS }),
            )
            .await?;
        let mut out = Vec::new();
        for msg in parse_receive(&res) {
            let keys: Vec<(String, Product)> = msg.keys.iter().filter_map(|k| wanted_for(&self.app, k).map(|p| (k.clone(), p))).collect();
            if keys.is_empty() {
                tracing::debug!("goes sqs: no wanted object in message, deleting ({:?})", msg.keys);
                self.delete(http, &msg.receipt).await?;
                continue;
            }
            // A message is acked as a whole, so either every object in it becomes a payload or none
            // does and the visibility timeout redelivers it (NODD sends one object per message).
            match self.download_all(http, &keys, &msg.receipt).await {
                Ok(payloads) => out.extend(payloads),
                Err(e) => tracing::warn!("goes sqs: {e:#}; message left on queue"),
            }
        }
        Ok(out)
    }

    fn normalize(&self, raw: &RawPayload) -> Result<Vec<Row>> {
        normalize_object(raw, &self.app)
    }

    async fn ack(&self, ctx: &FetchCtx<'_>, raw: &RawPayload) -> Result<()> {
        match &raw.ack {
            Some(receipt) => self.delete(&ctx.state.http, receipt).await,
            None => Ok(()),
        }
    }
}

// ---- SigV4 (AWS Signature Version 4), hand-rolled on hmac/sha2 which are already dependencies. ----

const AMZ_DATE: &str = "%Y%m%dT%H%M%SZ";

pub(crate) struct SignInput<'a> {
    pub method: &'a str,
    /// Already-normalised absolute path, e.g. `/`.
    pub path: &'a str,
    /// Raw query string without `?` (pairs already percent-encoded), may be empty.
    pub query: &'a str,
    /// Lower-case header names; must include `host` and `x-amz-date`.
    pub headers: &'a [(&'a str, &'a str)],
    pub payload: &'a [u8],
    pub now: DateTime<Utc>,
    pub region: &'a str,
    pub service: &'a str,
    pub key_id: &'a str,
    pub secret: &'a str,
}

fn hex_sha256(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// `Authorization` header value for the request.
pub(crate) fn sigv4(input: &SignInput) -> String {
    let mut headers: Vec<(String, String)> =
        input.headers.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.split_whitespace().collect::<Vec<_>>().join(" "))).collect();
    headers.sort();
    let signed_headers = headers.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
    let canonical_headers: String = headers.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let mut query: Vec<&str> = input.query.split('&').filter(|s| !s.is_empty()).collect();
    query.sort();
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        input.method,
        input.path,
        query.join("&"),
        canonical_headers,
        signed_headers,
        hex_sha256(input.payload)
    );
    let date = input.now.format("%Y%m%d").to_string();
    let scope = format!("{date}/{}/{}/aws4_request", input.region, input.service);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{scope}\n{}",
        input.now.format(AMZ_DATE),
        hex_sha256(canonical_request.as_bytes())
    );
    let k_date = hmac_sha256(format!("AWS4{}", input.secret).as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, input.region.as_bytes());
    let k_service = hmac_sha256(&k_region, input.service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));
    format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}", input.key_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECEIVE: &str = include_str!("../../../fixtures/goes/sqs-receive.json");

    #[test]
    fn goes_sqs_parses_recorded_receive_response_and_filters_products() {
        let res: Value = serde_json::from_str(RECEIVE).unwrap();
        let msgs = parse_receive(&res);
        assert_eq!(msgs.len(), 5);
        // 1: SNS-wrapped LSTC event.
        assert_eq!(msgs[0].receipt, "AQEBlstc0001");
        assert_eq!(
            msgs[0].keys,
            ["ABI-L2-LSTC/2026/272/15/OR_ABI-L2-LSTC-M6_G19_s20262721501171_e20262721503544_c20262721505510.nc"]
        );
        assert_eq!(wanted(&msgs[0].keys[0]), Some(Product::Lst));
        // 2: a product we do not consume passes the SNS filter only if the policy is missing; ignored here.
        assert_eq!(msgs[1].keys.len(), 1);
        assert!(msgs[1].keys[0].starts_with("ABI-L1b-RadC/"));
        assert_eq!(wanted(&msgs[1].keys[0]), None);
        // 3: ACMC at :06 is dropped by the hourly rule, 4: ACMC at :01 is kept.
        assert_eq!(wanted(&msgs[2].keys[0]), None);
        assert_eq!(wanted(&msgs[3].keys[0]), Some(Product::Acm));
        // 5: raw delivery (S3 event without the SNS envelope) with two records, one of them a delete.
        assert_eq!(msgs[4].keys.len(), 1);
        assert_eq!(wanted(&msgs[4].keys[0]), Some(Product::Sst));
        assert_eq!(wanted("ABI-L2-FDCC/2026/272/15/OR_ABI-L2-FDCC-M6_G19_s20262721531171_e2_c3.nc"), Some(Product::Fdc));
        // Garbage bodies yield a message with no keys, so the consumer deletes them.
        let junk = json!({ "Messages": [{ "ReceiptHandle": "r", "Body": "not json" }] });
        assert_eq!(parse_receive(&junk), [Message { receipt: "r".into(), keys: vec![] }]);
        assert!(parse_receive(&json!({})).is_empty());
    }

    #[test]
    fn goes_sqs_sigv4_matches_aws_reference_vector() {
        // AWS "Signature Version 4 signing process" worked example: IAM ListUsers, 2015-08-30T12:36:00Z.
        let now = DateTime::parse_from_rfc3339("2015-08-30T12:36:00Z").unwrap().with_timezone(&Utc);
        let auth = sigv4(&SignInput {
            method: "GET",
            path: "/",
            query: "Action=ListUsers&Version=2010-05-08",
            headers: &[
                ("content-type", "application/x-www-form-urlencoded; charset=utf-8"),
                ("host", "iam.amazonaws.com"),
                ("x-amz-date", "20150830T123600Z"),
            ],
            payload: b"",
            now,
            region: "us-east-1",
            service: "iam",
            key_id: "AKIDEXAMPLE",
            secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        });
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, \
             SignedHeaders=content-type;host;x-amz-date, \
             Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
        );
    }

    fn python() -> Arc<App> {
        Arc::new(crate::hotspot::score::testkit::python_app())
    }

    #[test]
    fn goes_sqs_source_is_enabled_only_with_queue_and_keys() {
        let app = python();
        let mut config = Config::for_tests();
        assert!(sources(&config, &app).is_empty());
        config.goes_sqs_url = Some("https://sqs.us-east-1.amazonaws.com/123456789012/goes19-nodd".into());
        config.aws_access_key_id = Some("AKIDEXAMPLE".into());
        assert!(sources(&config, &app).is_empty(), "secret missing");
        config.aws_secret_access_key = Some("secret".into());
        let s = sources(&config, &app);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].info().id, "goes19");
        assert_eq!(s[0].info().mode, Mode::Push);
        assert_eq!(s[0].min_interval(), Duration::ZERO);
        let g = GoesSqs::new(config.goes_sqs_url.as_deref().unwrap(), "k", "s", app.clone()).unwrap();
        assert_eq!(g.region, "us-east-1");
        assert_eq!(g.endpoint, "https://sqs.us-east-1.amazonaws.com/");
        assert!(GoesSqs::new("http://sqs.us-east-1.amazonaws.com/1/q", "k", "s", app.clone()).is_err());
        assert!(GoesSqs::new("https://example.com/1/q", "k", "s", app).is_err());
    }

    #[test]
    fn goes_sqs_normalize_decodes_fixture_bytes() {
        let app = python();
        let path = decode::tests::fixture(Product::Fdc).unwrap();
        let g = GoesSqs::new("https://sqs.us-east-1.amazonaws.com/1/q", "k", "s", app.clone()).unwrap();
        let raw = RawPayload {
            source_url: format!("{BUCKET_URL}ABI-L2-FDCC/2026/272/15/{}", path.file_name().unwrap().to_str().unwrap()),
            content_type: "application/x-netcdf".into(),
            bytes: std::fs::read(&path).unwrap(),
            http_status: Some(200),
            fetched_at: 0,
            next_cursor: None,
            ack: Some("AQEB".into()),
        };
        let rows = g.normalize(&raw).unwrap();
        assert_eq!(rows.len(), decode::rows(&decode::decode_file(&path, Product::Fdc, &app).unwrap(), &app).len());
        assert!(g.normalize(&RawPayload { source_url: "https://x/y.nc".into(), ..raw.clone() }).is_err());
        // Lionfish Watch lists SSTF only: the fire product is skipped (no rows, no error), and
        // the queue consumer never downloads it.
        let lf = crate::ingest::poll::bio::testing::lionfish();
        assert_eq!(products(&lf), ["ABI-L2-SSTF"]);
        assert!(products(&app).contains(&"ABI-L2-FDCC".to_string()));
        let g = GoesSqs::new("https://sqs.us-east-1.amazonaws.com/1/q", "k", "s", lf.clone()).unwrap();
        assert!(g.normalize(&raw).unwrap().is_empty());
        let fdc_key = "ABI-L2-FDCC/2026/272/15/OR_ABI-L2-FDCC-M6_G19_s20262721531171_e2_c3.nc";
        assert_eq!(wanted_for(&lf, fdc_key), None);
        assert_eq!(wanted_for(&app, fdc_key), Some(Product::Fdc));
        assert_eq!(wanted_for(&lf, "ABI-L2-SSTF/2026/272/15/OR_ABI-L2-SSTF-M6_G19_s1_e2_c3.nc"), Some(Product::Sst));
        // Per-app queue URLs take precedence over the shared one.
        let mut config = Config::for_tests();
        config.goes_sqs_url = Some("https://sqs.us-east-1.amazonaws.com/1/shared".into());
        config.goes_sqs_urls = vec![("lionfish".into(), "https://sqs.us-east-1.amazonaws.com/1/lionfish".into())];
        assert_eq!(config.goes_sqs_url_for("lionfish"), Some("https://sqs.us-east-1.amazonaws.com/1/lionfish"));
        assert_eq!(config.goes_sqs_url_for("python"), Some("https://sqs.us-east-1.amazonaws.com/1/shared"));
        config.aws_access_key_id = Some("k".into());
        config.aws_secret_access_key = Some("s".into());
        assert_eq!(configure(&config, &lf).unwrap().queue_url, "https://sqs.us-east-1.amazonaws.com/1/lionfish");
    }
}
