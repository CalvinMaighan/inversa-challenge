//! Per-source rate governor (T5), after God's Eye View's OpenSky proxy governor:
//!
//! - a minimum interval between fetches (the source's cadence);
//! - on 429, 5xx or a transport error the interval doubles, up to a cap (30 min by default);
//! - `Retry-After` (seconds or HTTP date) and `X-Rate-Limit-Retry-After-Seconds` are honoured:
//!   no attempt is made before they pass;
//! - a success resets the interval to the minimum;
//! - [`Governor::snapshot`] and [`note`] expose the state for the feed-state note.
//!
//! Adapters surface HTTP failures by returning [`HttpStatusError`] (see [`check_response`]) so the
//! scheduler can read the status and `Retry-After`. A plain `reqwest::Error` with a status works too.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};

/// Default ceiling for the doubled interval.
pub const DEFAULT_CAP: Duration = Duration::from_secs(30 * 60);
/// Backoff never starts below this, so zero-interval (long-poll) sources still back off.
pub const BACKOFF_FLOOR: Duration = Duration::from_secs(5);
/// Upper bound on an honoured `Retry-After`, against a hostile or broken header.
pub const RETRY_AFTER_MAX: Duration = Duration::from_secs(24 * 60 * 60);

/// Result of one fetch attempt, as the governor sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attempt {
    Success,
    /// HTTP 429 or 5xx.
    Throttled { status: u16, retry_after: Option<Duration> },
    /// Any other failure (transport error, other 4xx, parse error). Also backs off: a failing
    /// upstream should not be hammered at full cadence.
    Failed { status: Option<u16> },
}

/// Observable governor state (for feed-state notes and GraphQL).
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub min_interval: Duration,
    pub interval: Duration,
    pub consecutive_failures: u32,
    pub last_status: Option<u16>,
    /// Unix ms before which no attempt will be made; `None` when an attempt is due now.
    pub next_attempt_at: Option<i64>,
    /// Unix ms until which an upstream `Retry-After` holds.
    pub retry_after_until: Option<i64>,
}

impl Snapshot {
    pub fn backing_off(&self) -> bool {
        self.consecutive_failures > 0
    }

    /// Human note for the feed-state envelope; `None` when nominal.
    pub fn note(&self) -> Option<String> {
        if !self.backing_off() {
            return None;
        }
        let cause = match self.last_status {
            Some(s) => format!("HTTP {s}"),
            None => "fetch error".to_string(),
        };
        let mut note = format!(
            "backoff {}s after {cause} ({} consecutive)",
            self.interval.as_secs(),
            self.consecutive_failures
        );
        if let Some(until) = self.retry_after_until {
            if let Some(t) = DateTime::<Utc>::from_timestamp_millis(until) {
                note.push_str(&format!(", Retry-After until {}", t.format("%H:%M:%SZ")));
            }
        }
        if let Some(next) = self.next_attempt_at.and_then(DateTime::<Utc>::from_timestamp_millis) {
            note.push_str(&format!(", next attempt {}", next.format("%H:%M:%SZ")));
        }
        Some(note)
    }
}

#[derive(Debug)]
struct Inner {
    interval: Duration,
    /// Earliest time of the next attempt; `None` = now.
    next_at: Option<Instant>,
    retry_after_until: Option<Instant>,
    consecutive_failures: u32,
    last_status: Option<u16>,
}

#[derive(Debug)]
pub struct Governor {
    min_interval: Duration,
    cap: Duration,
    inner: Mutex<Inner>,
}

impl Governor {
    pub fn new(min_interval: Duration) -> Self {
        Self::with_cap(min_interval, DEFAULT_CAP)
    }

    pub fn with_cap(min_interval: Duration, cap: Duration) -> Self {
        let cap = cap.max(min_interval);
        Governor {
            min_interval,
            cap,
            inner: Mutex::new(Inner {
                interval: min_interval,
                next_at: None,
                retry_after_until: None,
                consecutive_failures: 0,
                last_status: None,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // The state is plain data; a panic elsewhere cannot leave it inconsistent.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// How long to wait at `now` before the next attempt.
    pub fn wait(&self, now: Instant) -> Duration {
        self.lock().next_at.map(|t| t.saturating_duration_since(now)).unwrap_or(Duration::ZERO)
    }

    /// Current interval (min interval when healthy, doubled while backing off).
    #[allow(dead_code)] // tests; feed state reads it through `snapshot`
    pub fn interval(&self) -> Duration {
        self.lock().interval
    }

    /// Record an attempt that finished at `now` and schedule the next one.
    pub fn record(&self, attempt: Attempt, now: Instant) {
        let mut s = self.lock();
        match attempt {
            Attempt::Success => {
                s.interval = self.min_interval;
                s.consecutive_failures = 0;
                s.last_status = None;
                s.retry_after_until = None;
                s.next_at = Some(now + self.min_interval);
            }
            Attempt::Throttled { status, retry_after } => {
                self.back_off(&mut s, now, Some(status));
                if let Some(ra) = retry_after {
                    let until = now + ra.min(RETRY_AFTER_MAX);
                    s.retry_after_until = Some(until);
                    if s.next_at.is_none_or(|t| t < until) {
                        s.next_at = Some(until);
                    }
                } else {
                    s.retry_after_until = None;
                }
            }
            Attempt::Failed { status } => {
                self.back_off(&mut s, now, status);
                s.retry_after_until = None;
            }
        }
    }

    fn back_off(&self, s: &mut Inner, now: Instant, status: Option<u16>) {
        s.interval = (s.interval * 2).max(BACKOFF_FLOOR.min(self.cap)).min(self.cap);
        s.consecutive_failures = s.consecutive_failures.saturating_add(1);
        s.last_status = status;
        s.next_at = Some(now + s.interval);
    }

    pub fn snapshot(&self, now: Instant) -> Snapshot {
        let s = self.lock();
        let now_ms = Utc::now().timestamp_millis();
        let to_unix = |t: Instant| now_ms + t.saturating_duration_since(now).as_millis() as i64;
        Snapshot {
            min_interval: self.min_interval,
            interval: s.interval,
            consecutive_failures: s.consecutive_failures,
            last_status: s.last_status,
            next_attempt_at: s.next_at.filter(|t| *t > now).map(to_unix),
            retry_after_until: s.retry_after_until.filter(|t| *t > now).map(to_unix),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Process-wide registry, so feed state can read any source's governor without holding a handle.
// ---------------------------------------------------------------------------------------------

fn registry() -> &'static Mutex<HashMap<String, Arc<Governor>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<Governor>>>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

/// The governor for `source_id`, created with `min_interval` on first use.
pub fn for_source(source_id: &str, min_interval: Duration) -> Arc<Governor> {
    let mut map = registry().lock().unwrap_or_else(|p| p.into_inner());
    map.entry(source_id.to_string()).or_insert_with(|| Arc::new(Governor::new(min_interval))).clone()
}

/// Snapshot of a registered source's governor.
#[allow(dead_code)] // read by feed_state (T4)
pub fn snapshot(source_id: &str) -> Option<Snapshot> {
    let gov = registry().lock().unwrap_or_else(|p| p.into_inner()).get(source_id).cloned()?;
    Some(gov.snapshot(Instant::now()))
}

/// Feed-state note for a source: `Some` only while it is backing off.
#[allow(dead_code)] // read by feed_state (T4)
pub fn note(source_id: &str) -> Option<String> {
    snapshot(source_id).and_then(|s| s.note())
}

// ---------------------------------------------------------------------------------------------
// Classifying fetch errors
// ---------------------------------------------------------------------------------------------

/// A non-success HTTP response, with the `Retry-After` it carried.
#[derive(Debug, Clone, thiserror::Error)]
#[error("HTTP {status} from {url}")]
pub struct HttpStatusError {
    pub status: u16,
    pub retry_after: Option<Duration>,
    pub url: String,
}

/// Pass successful responses through; turn anything else into [`HttpStatusError`].
/// For poll adapters (T8/T9): `let res = governor::check_response(http.get(url).send().await?)?;`
#[allow(dead_code)]
pub fn check_response(res: reqwest::Response) -> Result<reqwest::Response, HttpStatusError> {
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    Err(HttpStatusError {
        status: status.as_u16(),
        retry_after: retry_after(res.headers(), Utc::now()),
        url: res.url().to_string(),
    })
}

/// `Retry-After` (delta seconds or HTTP date), or OpenSky's `X-Rate-Limit-Retry-After-Seconds`.
pub fn retry_after(headers: &reqwest::header::HeaderMap, now: DateTime<Utc>) -> Option<Duration> {
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim);
    if let Some(secs) = get("x-rate-limit-retry-after-seconds").and_then(|v| v.parse::<u64>().ok()) {
        return Some(Duration::from_secs(secs));
    }
    let value = get("retry-after")?;
    if let Ok(secs) = value.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    let at = DateTime::parse_from_rfc2822(value).ok()?.with_timezone(&Utc);
    Some((at - now).to_std().unwrap_or(Duration::ZERO))
}

fn is_throttle(status: u16) -> bool {
    status == 429 || (500..=599).contains(&status)
}

/// Map a fetch error to an [`Attempt`], looking through the anyhow chain.
pub fn classify(err: &anyhow::Error) -> Attempt {
    for cause in err.chain() {
        if let Some(e) = cause.downcast_ref::<HttpStatusError>() {
            return if is_throttle(e.status) {
                Attempt::Throttled { status: e.status, retry_after: e.retry_after }
            } else {
                Attempt::Failed { status: Some(e.status) }
            };
        }
        if let Some(e) = cause.downcast_ref::<reqwest::Error>() {
            if let Some(status) = e.status().map(|s| s.as_u16()) {
                return if is_throttle(status) {
                    Attempt::Throttled { status, retry_after: None }
                } else {
                    Attempt::Failed { status: Some(status) }
                };
            }
        }
    }
    Attempt::Failed { status: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: fn(u64) -> Duration = Duration::from_secs;

    #[test]
    fn governor_min_interval_between_successes() {
        let g = Governor::new(S(60));
        let t0 = Instant::now();
        assert_eq!(g.wait(t0), Duration::ZERO, "first attempt is immediate");
        g.record(Attempt::Success, t0);
        assert_eq!(g.wait(t0), S(60));
        assert_eq!(g.wait(t0 + S(45)), S(15));
        assert_eq!(g.wait(t0 + S(90)), Duration::ZERO);
        assert!(g.snapshot(t0).note().is_none());
    }

    #[test]
    fn governor_doubles_on_429_and_5xx_up_to_cap() {
        let g = Governor::with_cap(S(60), S(30 * 60));
        let t = Instant::now();
        let mut expected = 60;
        for (i, status) in [429u16, 503, 500, 429, 502, 504, 429, 500, 503].into_iter().enumerate() {
            g.record(Attempt::Throttled { status, retry_after: None }, t);
            expected = (expected * 2).min(1800);
            assert_eq!(g.interval(), S(expected), "after failure {} ({status})", i + 1);
            assert_eq!(g.wait(t), S(expected));
        }
        assert_eq!(g.interval(), S(1800), "capped at 30 min");
        let snap = g.snapshot(t);
        assert_eq!(snap.consecutive_failures, 9);
        assert_eq!(snap.last_status, Some(503));
        let note = snap.note().unwrap();
        assert!(note.contains("backoff 1800s after HTTP 503 (9 consecutive)"), "{note}");
    }

    #[test]
    fn governor_honors_retry_after() {
        let g = Governor::new(S(60));
        let t = Instant::now();
        // Retry-After longer than the doubled interval wins.
        g.record(Attempt::Throttled { status: 429, retry_after: Some(S(600)) }, t);
        assert_eq!(g.interval(), S(120));
        assert_eq!(g.wait(t), S(600));
        assert!(g.snapshot(t).retry_after_until.is_some());
        assert!(g.snapshot(t).note().unwrap().contains("Retry-After until"));
        // A shorter Retry-After never shortens the backoff.
        g.record(Attempt::Throttled { status: 503, retry_after: Some(S(1)) }, t);
        assert_eq!(g.wait(t), S(240));
        // Retry-After is honoured past the doubling cap.
        let g = Governor::with_cap(S(60), S(300));
        g.record(Attempt::Throttled { status: 429, retry_after: Some(S(3600)) }, t);
        assert_eq!(g.wait(t), S(3600));
    }

    #[test]
    fn governor_resets_on_success() {
        let g = Governor::new(S(30));
        let t = Instant::now();
        for _ in 0..4 {
            g.record(Attempt::Throttled { status: 500, retry_after: Some(S(900)) }, t);
        }
        assert_eq!(g.interval(), S(480));
        g.record(Attempt::Success, t + S(900));
        assert_eq!(g.interval(), S(30));
        assert_eq!(g.wait(t + S(900)), S(30));
        let snap = g.snapshot(t + S(900));
        assert_eq!(snap.consecutive_failures, 0);
        assert_eq!(snap.last_status, None);
        assert!(snap.retry_after_until.is_none());
        assert!(snap.note().is_none());
    }

    #[test]
    fn governor_zero_interval_still_backs_off() {
        let g = Governor::new(Duration::ZERO);
        let t = Instant::now();
        g.record(Attempt::Failed { status: None }, t);
        assert_eq!(g.interval(), BACKOFF_FLOOR);
        g.record(Attempt::Failed { status: None }, t);
        assert_eq!(g.interval(), BACKOFF_FLOOR * 2);
        g.record(Attempt::Success, t);
        assert_eq!(g.wait(t), Duration::ZERO);
    }

    #[test]
    fn governor_parses_retry_after_headers() {
        use reqwest::header::{HeaderMap, HeaderValue};
        let now = DateTime::parse_from_rfc3339("2026-09-30T12:00:00Z").unwrap().with_timezone(&Utc);
        let mut h = HeaderMap::new();
        assert_eq!(retry_after(&h, now), None);
        h.insert("retry-after", HeaderValue::from_static("120"));
        assert_eq!(retry_after(&h, now), Some(S(120)));
        h.insert("retry-after", HeaderValue::from_static("Wed, 30 Sep 2026 12:05:00 GMT"));
        assert_eq!(retry_after(&h, now), Some(S(300)));
        h.insert("retry-after", HeaderValue::from_static("Wed, 30 Sep 2026 11:00:00 GMT"));
        assert_eq!(retry_after(&h, now), Some(Duration::ZERO));
        h.insert("x-rate-limit-retry-after-seconds", HeaderValue::from_static("45"));
        assert_eq!(retry_after(&h, now), Some(S(45)));
    }

    #[test]
    fn governor_classifies_errors() {
        let e = anyhow::Error::new(HttpStatusError { status: 429, retry_after: Some(S(7)), url: "u".into() })
            .context("fetch inat");
        assert_eq!(classify(&e), Attempt::Throttled { status: 429, retry_after: Some(S(7)) });
        let e = anyhow::Error::new(HttpStatusError { status: 502, retry_after: None, url: "u".into() });
        assert_eq!(classify(&e), Attempt::Throttled { status: 502, retry_after: None });
        let e = anyhow::Error::new(HttpStatusError { status: 404, retry_after: None, url: "u".into() });
        assert_eq!(classify(&e), Attempt::Failed { status: Some(404) });
        assert_eq!(classify(&anyhow::anyhow!("parse failed")), Attempt::Failed { status: None });
    }

    #[test]
    fn governor_registry_exposes_note() {
        let id = "governor-test-registry";
        let g = for_source(id, S(60));
        assert!(Arc::ptr_eq(&g, &for_source(id, S(999))), "one governor per source");
        assert!(note(id).is_none());
        g.record(Attempt::Throttled { status: 429, retry_after: None }, Instant::now());
        assert!(note(id).unwrap().starts_with("backoff 120s after HTTP 429"));
        assert!(snapshot("governor-test-unknown").is_none());
    }
}
