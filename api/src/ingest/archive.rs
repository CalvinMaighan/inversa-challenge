//! Disk and R2 archive implementations (T5). The trait and `MemArchive` live in `crate::archive`.
//!
//! Keys look like `raw/{source}/{yyyy}/{mm}/{dd}/{uuidv7}.{ext}.gz` (see [`raw_key`]). Objects are
//! stored exactly as given; the ingest pipeline gzips before calling `put`.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, bail, Context};
use async_trait::async_trait;
use aws_credential_types::Credentials;
use aws_sigv4::http_request::{
    sign, PayloadChecksumKind, PercentEncodingMode, SignableBody, SignableRequest, SigningSettings,
    UriPathNormalizationMode,
};
use aws_sigv4::sign::v4;
use chrono::{DateTime, Datelike, Utc};
use sha2::{Digest, Sha256};

use crate::archive::Archive;
use crate::state::{Config, R2Config};

/// R2 when configured, otherwise a directory under `<data_dir>/archive`.
pub fn from_config(config: &Config) -> anyhow::Result<Arc<dyn Archive>> {
    match &config.r2 {
        Some(r2) => {
            tracing::info!("archive: r2 bucket {}", r2.bucket_raw);
            Ok(Arc::new(R2Archive::new(r2)?))
        }
        None => {
            let root = config.data_dir.join("archive");
            tracing::info!("archive: directory {}", root.display());
            Ok(Arc::new(DirArchive::new(root)))
        }
    }
}

/// File extension for a payload's content type, without the trailing `.gz`.
pub fn extension_for(content_type: &str) -> &'static str {
    let mime = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match mime.as_str() {
        "application/json" | "application/geo+json" | "application/ld+json" | "text/json" => "json",
        "application/xml" | "text/xml" | "application/atom+xml" | "application/rss+xml" | "application/cap+xml" => "xml",
        "text/csv" | "application/csv" => "csv",
        "text/plain" => "txt",
        "text/html" => "html",
        "application/x-netcdf" | "application/netcdf" | "application/x-netcdf4" => "nc",
        m if m.ends_with("+json") => "json",
        m if m.ends_with("+xml") => "xml",
        _ => "bin",
    }
}

/// `raw/{source}/{yyyy}/{mm}/{dd}/{uuidv7}.{ext}.gz`, dated by `fetched_at` (UTC).
pub fn raw_key(source_id: &str, fetched_at_ms: i64, content_type: &str) -> String {
    let at = DateTime::<Utc>::from_timestamp_millis(fetched_at_ms).unwrap_or_else(Utc::now);
    format!(
        "raw/{source_id}/{:04}/{:02}/{:02}/{}.{}.gz",
        at.year(),
        at.month(),
        at.day(),
        uuid::Uuid::now_v7(),
        extension_for(content_type)
    )
}

/// Reject keys that could escape the archive root or that S3 would treat oddly.
fn validate_key(key: &str) -> anyhow::Result<()> {
    if key.is_empty() || key.len() > 1024 {
        bail!("archive: key length {} out of range", key.len());
    }
    if key.starts_with('/') || key.contains('\\') || key.contains('\0') {
        bail!("archive: invalid key {key:?}");
    }
    if key.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") {
        bail!("archive: invalid key segment in {key:?}");
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// DirArchive
// ---------------------------------------------------------------------------------------------

/// Local directory archive for dev. Writes are atomic (temp file + rename).
pub struct DirArchive {
    root: PathBuf,
}

impl DirArchive {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        DirArchive { root: root.into() }
    }

    fn path_for(&self, key: &str) -> anyhow::Result<PathBuf> {
        validate_key(key)?;
        let rel = Path::new(key);
        if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
            bail!("archive: invalid key {key:?}");
        }
        Ok(self.root.join(rel))
    }
}

#[async_trait]
impl Archive for DirArchive {
    async fn put(&self, key: &str, bytes: Vec<u8>, _content_type: &str) -> anyhow::Result<()> {
        let path = self.path_for(key)?;
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let dir = path.parent().ok_or_else(|| anyhow!("archive: key has no parent"))?;
            std::fs::create_dir_all(dir).with_context(|| format!("archive: mkdir {}", dir.display()))?;
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("object");
            let tmp = dir.join(format!(".{file_name}.{}.tmp", uuid::Uuid::now_v7()));
            std::fs::write(&tmp, &bytes).with_context(|| format!("archive: write {}", tmp.display()))?;
            std::fs::rename(&tmp, &path).map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                anyhow!("archive: rename to {}: {e}", path.display())
            })
        })
        .await?
    }

    async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        let path = self.path_for(key)?;
        let key = key.to_string();
        tokio::task::spawn_blocking(move || match std::fs::read(&path) {
            Ok(bytes) => Ok(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(anyhow!("archive: no object {key}")),
            Err(e) => Err(anyhow!("archive: read {}: {e}", path.display())),
        })
        .await?
    }
}

// ---------------------------------------------------------------------------------------------
// R2Archive
// ---------------------------------------------------------------------------------------------

const R2_REGION: &str = "auto";
const S3_SERVICE: &str = "s3";
const PUT_ATTEMPTS: u32 = 3;
const MAX_INLINE_RETRY_AFTER: Duration = Duration::from_secs(10);

/// Cloudflare R2 through its S3-compatible API, signed with SigV4 (region `auto`, service `s3`).
pub struct R2Archive {
    endpoint: String,
    bucket: String,
    credentials: Credentials,
    http: reqwest::Client,
}

impl R2Archive {
    pub fn new(config: &R2Config) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .build()
            .context("archive: r2 http client")?;
        Ok(R2Archive {
            endpoint: format!("https://{}.r2.cloudflarestorage.com", config.account_id),
            bucket: config.bucket_raw.clone(),
            credentials: Credentials::new(
                config.access_key_id.clone(),
                config.secret_access_key.clone(),
                None,
                None,
                "r2",
            ),
            http,
        })
    }

    fn url_for(&self, key: &str) -> anyhow::Result<String> {
        validate_key(key)?;
        Ok(format!("{}/{}/{}", self.endpoint, uri_encode_path(&self.bucket), uri_encode_path(key)))
    }

    async fn send_signed(
        &self,
        method: reqwest::Method,
        url: &str,
        headers: &[(&str, &str)],
        body: Vec<u8>,
    ) -> anyhow::Result<reqwest::Response> {
        let payload_hash = hex::encode(Sha256::digest(&body));
        let signed = sign_headers(
            &self.credentials,
            method.as_str(),
            url,
            headers,
            &payload_hash,
            R2_REGION,
            S3_SERVICE,
            SystemTime::now(),
        )?;
        let mut req = self.http.request(method, url);
        for (name, value) in headers.iter().filter(|(n, _)| !n.eq_ignore_ascii_case("host")) {
            req = req.header(*name, *value);
        }
        for (name, value) in &signed {
            req = req.header(name.as_str(), value.as_str());
        }
        Ok(req.body(body).send().await?)
    }
}

fn retryable(status: reqwest::StatusCode) -> bool {
    status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

#[async_trait]
impl Archive for R2Archive {
    async fn put(&self, key: &str, bytes: Vec<u8>, content_type: &str) -> anyhow::Result<()> {
        let url = self.url_for(key)?;
        let headers = [("content-type", content_type)];
        let mut last_err = anyhow!("archive: r2 put {key}: no attempt made");
        for attempt in 0..PUT_ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(250 * 4u64.pow(attempt - 1))).await;
            }
            match self.send_signed(reqwest::Method::PUT, &url, &headers, bytes.clone()).await {
                Ok(res) if res.status().is_success() => return Ok(()),
                Ok(res) => {
                    let status = res.status();
                    let wait = crate::ingest::governor::retry_after(res.headers(), Utc::now());
                    let body = res.text().await.unwrap_or_default();
                    last_err = anyhow!("archive: r2 put {key}: HTTP {status}: {}", truncate(&body, 300));
                    if !retryable(status) {
                        return Err(last_err);
                    }
                    // Honour a short Retry-After; a long one fails the put and the supervisor backs off.
                    if let Some(wait) = wait.filter(|w| *w <= MAX_INLINE_RETRY_AFTER) {
                        tokio::time::sleep(wait).await;
                    }
                }
                Err(e) => last_err = e.context(format!("archive: r2 put {key}")),
            }
        }
        Err(last_err)
    }

    async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        let url = self.url_for(key)?;
        let res = self.send_signed(reqwest::Method::GET, &url, &[], Vec::new()).await?;
        let status = res.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            bail!("archive: no object {key}");
        }
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            bail!("archive: r2 get {key}: HTTP {status}: {}", truncate(&body, 300));
        }
        Ok(res.bytes().await?.to_vec())
    }
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// S3 path encoding: every byte except unreserved characters and `/` is percent-encoded.
fn uri_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// SigV4-sign a request for S3. `url` must already be percent-encoded. `headers` are the request
/// headers to sign besides `host` (taken from the URL). Returns the headers to add:
/// `authorization`, `x-amz-date`, `x-amz-content-sha256`.
#[allow(clippy::too_many_arguments)]
pub fn sign_headers(
    credentials: &Credentials,
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    payload_sha256_hex: &str,
    region: &str,
    service: &str,
    time: SystemTime,
) -> anyhow::Result<Vec<(String, String)>> {
    let host = reqwest::Url::parse(url)
        .context("archive: sign url")?
        .host_str()
        .ok_or_else(|| anyhow!("archive: sign url has no host"))?
        .to_string();
    let mut all: Vec<(&str, &str)> = vec![("host", host.as_str())];
    all.extend(headers.iter().copied().filter(|(n, _)| !n.eq_ignore_ascii_case("host")));

    let mut settings = SigningSettings::default();
    settings.payload_checksum_kind = PayloadChecksumKind::XAmzSha256;
    settings.percent_encoding_mode = PercentEncodingMode::Single;
    settings.uri_path_normalization_mode = UriPathNormalizationMode::Disabled;

    let identity = credentials.clone().into();
    let params = v4::SigningParams::builder()
        .identity(&identity)
        .region(region)
        .name(service)
        .time(time)
        .settings(settings)
        .build()
        .map_err(|e| anyhow!("archive: sigv4 params: {e}"))?
        .into();
    let signable = SignableRequest::new(
        method,
        url,
        all.into_iter(),
        SignableBody::Precomputed(payload_sha256_hex.to_string()),
    )
    .map_err(|e| anyhow!("archive: sigv4 request: {e}"))?;
    let (instructions, _signature) =
        sign(signable, &params).map_err(|e| anyhow!("archive: sigv4 sign: {e}"))?.into_parts();
    Ok(instructions.headers().map(|(k, v)| (k.to_string(), v.to_string())).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Config;

    fn temp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("inversa-archive-test-{tag}-{}", uuid::Uuid::now_v7()))
    }

    #[tokio::test]
    async fn archive_dir_round_trip() {
        let root = temp_root("rt");
        let archive = DirArchive::new(&root);
        let key = raw_key("inat", 1_760_000_000_000, "application/json");
        let body: Vec<u8> = (0..=255u8).cycle().take(70_000).collect();
        archive.put(&key, body.clone(), "application/gzip").await.unwrap();
        assert_eq!(archive.get(&key).await.unwrap(), body);
        // Overwrite is idempotent, not an error.
        archive.put(&key, b"second".to_vec(), "application/gzip").await.unwrap();
        assert_eq!(archive.get(&key).await.unwrap(), b"second");
        // No temp files left behind.
        let dir = root.join(Path::new(&key).parent().unwrap());
        let names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 1, "{names:?}");
        let missing = archive.get("raw/inat/2020/01/01/nope.json.gz").await.unwrap_err();
        assert!(missing.to_string().contains("no object"), "{missing}");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn archive_dir_rejects_traversal() {
        let archive = DirArchive::new(temp_root("trav"));
        for key in ["../escape", "raw/../../x", "/etc/passwd", "raw//x", "raw/./x", "", "raw\\x"] {
            assert!(archive.put(key, vec![1], "x").await.is_err(), "accepted {key:?}");
            assert!(archive.get(key).await.is_err(), "accepted {key:?}");
        }
    }

    #[test]
    fn archive_raw_key_layout() {
        // 2025-10-09T08:53:20Z
        let key = raw_key("nws", 1_759_999_999_999 + 1, "application/geo+json; charset=utf-8");
        let re_parts: Vec<&str> = key.split('/').collect();
        assert_eq!(&re_parts[..5], ["raw", "nws", "2025", "10", "09"]);
        let file = re_parts[5];
        assert!(file.ends_with(".json.gz"), "{file}");
        let id = file.trim_end_matches(".json.gz");
        let uuid = uuid::Uuid::parse_str(id).unwrap();
        assert_eq!(uuid.get_version_num(), 7);
        assert!(raw_key("x", 0, "text/xml").ends_with(".xml.gz"));
        assert!(raw_key("x", 0, "application/x-netcdf").ends_with(".nc.gz"));
        assert!(raw_key("x", 0, "application/octet-stream").ends_with(".bin.gz"));
        assert!(raw_key("x", 0, "text/csv").ends_with(".csv.gz"));
    }

    #[test]
    fn archive_from_config_picks_backend() {
        let mut config = Config::for_tests();
        config.data_dir = temp_root("cfg");
        assert!(from_config(&config).is_ok());
        config.r2 = Some(R2Config {
            account_id: "acct".into(),
            access_key_id: "AKID".into(),
            secret_access_key: "secret".into(),
            bucket_raw: "inversa-raw".into(),
        });
        let r2 = R2Archive::new(config.r2.as_ref().unwrap()).unwrap();
        assert_eq!(
            r2.url_for("raw/web/2026/09/30/a b+c.json.gz").unwrap(),
            "https://acct.r2.cloudflarestorage.com/inversa-raw/raw/web/2026/09/30/a%20b%2Bc.json.gz"
        );
        assert!(r2.url_for("../x").is_err());
    }

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> &'a str {
        headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()).unwrap_or("")
    }

    /// AWS documented example "GET Object" (Signature Version 4, header-based auth):
    /// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    #[test]
    fn archive_sigv4_matches_aws_get_object_vector() {
        let creds = Credentials::new(
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            None,
            None,
            "test",
        );
        let time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_369_353_600); // 2013-05-24T00:00:00Z
        let empty_sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let out = sign_headers(
            &creds,
            "GET",
            "https://examplebucket.s3.amazonaws.com/test.txt",
            &[("range", "bytes=0-9")],
            empty_sha,
            "us-east-1",
            "s3",
            time,
        )
        .unwrap();
        let auth = header(&out, "authorization");
        assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request"), "{auth}");
        assert!(auth.contains("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date"), "{auth}");
        assert!(
            auth.ends_with("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"),
            "{auth}"
        );
        assert_eq!(header(&out, "x-amz-date"), "20130524T000000Z");
        assert_eq!(header(&out, "x-amz-content-sha256"), empty_sha);
    }

    /// R2 requests use region `auto` and service `s3` in the credential scope.
    #[test]
    fn archive_sigv4_r2_scope() {
        let creds = Credentials::new("AKID", "SECRET", None, None, "test");
        let body_sha = hex::encode(Sha256::digest(b"hello"));
        let out = sign_headers(
            &creds,
            "PUT",
            "https://acct.r2.cloudflarestorage.com/inversa-raw/raw/web/2026/09/30/x.json.gz",
            &[("content-type", "application/gzip")],
            &body_sha,
            R2_REGION,
            S3_SERVICE,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_790_000_000),
        )
        .unwrap();
        let auth = header(&out, "authorization");
        assert!(auth.contains("/auto/s3/aws4_request"), "{auth}");
        assert!(auth.contains("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date"), "{auth}");
        assert_eq!(header(&out, "x-amz-content-sha256"), body_sha);
    }
}
