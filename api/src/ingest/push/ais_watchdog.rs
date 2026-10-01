//! Reconnect policy for the AISStream websocket (`ais.rs`). Pure: no sockets, no timers, no
//! clock. The connection task feeds it events with a monotonic time in ms and asks it when to
//! connect next and whether to recycle a quiet socket.
//!
//! The idea (not the code) follows the gods-eye-view watchdog: liveness is judged by data, not by
//! socket state, because AISStream can accept the handshake and then send nothing; and failures
//! are classified, because retrying harder is the wrong answer to most of them:
//!
//! - `Auth`: the key was rejected. Retrying cannot help, so the policy stops until the process
//!   restarts with another key (the feed shows the reason).
//! - `RateLimit`: wait what `Retry-After` says (at least [`Policy::rate_limit_floor_ms`]).
//! - `Transport` and `Quiet`: walk the backoff ladder; once it is exhausted, retry every
//!   [`Policy::down_retry_ms`]. Only data resets the ladder, so a server that accepts and closes
//!   at once cannot drive a busy loop.
//!
//! Every wait is at least [`Policy::min_gap_ms`] after the previous attempt.

/// Budgets, ms.
#[derive(Debug, Clone)]
pub struct Policy {
    /// Silence after which the feed is reported stale.
    pub stale_ms: u64,
    /// Silence after which an open socket is recycled.
    pub recycle_ms: u64,
    /// Delays before attempts 2, 3, ... after transport failures; its length is the budget before `Down`.
    pub backoff_ms: Vec<u64>,
    /// Retry cadence once the ladder is exhausted.
    pub down_retry_ms: u64,
    /// Wait after a 429 without a usable `Retry-After`, and the least wait after any 429.
    pub rate_limit_floor_ms: u64,
    /// No two attempts closer than this.
    pub min_gap_ms: u64,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            stale_ms: 120_000,
            recycle_ms: 300_000,
            backoff_ms: vec![5_000, 15_000, 60_000, 300_000],
            down_retry_ms: 900_000,
            rate_limit_floor_ms: 60_000,
            min_gap_ms: 1_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// The key was rejected (HTTP 401/403 on the upgrade, or an auth error envelope).
    Auth(String),
    /// HTTP 429 on the upgrade, or a rate-limit envelope; `retry_after_ms` from `Retry-After`.
    RateLimit { retry_after_ms: Option<u64>, message: String },
    /// Connect, TLS, protocol or close errors.
    Transport(String),
    /// The socket stayed open without data for `recycle_ms`.
    Quiet,
}

impl Failure {
    pub fn message(&self) -> String {
        match self {
            Failure::Auth(m) | Failure::Transport(m) | Failure::RateLimit { message: m, .. } => m.clone(),
            Failure::Quiet => "no AIS data on an open socket; recycled".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Health {
    Connecting,
    Live,
    Stale,
    Reconnecting,
    /// The backoff ladder is exhausted; retrying slowly.
    Down,
    /// The key was rejected; no more attempts.
    AuthFailed,
}

/// What the connection task should do now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
    Connect,
    Wait(u64),
    Stop,
}

#[derive(Debug, Clone)]
pub struct Watchdog {
    policy: Policy,
    /// Consecutive failures without data in between.
    failures: usize,
    next_at: Option<u64>,
    last_attempt: Option<u64>,
    /// When the current socket opened (None: no socket).
    open_since: Option<u64>,
    last_data: Option<u64>,
    health: Health,
    last_failure: Option<Failure>,
}

impl Watchdog {
    pub fn new(policy: Policy) -> Self {
        Watchdog {
            policy,
            failures: 0,
            next_at: Some(0),
            last_attempt: None,
            open_since: None,
            last_data: None,
            health: Health::Connecting,
            last_failure: None,
        }
    }

    /// When to connect: now, after a wait, or never (auth rejected).
    pub fn next(&self, now: u64) -> Next {
        match self.next_at {
            None => Next::Stop,
            Some(at) => {
                let floor = self.last_attempt.map_or(0, |t| t + self.policy.min_gap_ms);
                let at = at.max(floor);
                if now >= at {
                    Next::Connect
                } else {
                    Next::Wait(at - now)
                }
            }
        }
    }

    pub fn on_attempt(&mut self, now: u64) {
        self.last_attempt = Some(now);
        self.open_since = None;
        if self.health != Health::Down {
            self.health = if self.failures == 0 { Health::Connecting } else { Health::Reconnecting };
        }
    }

    /// The upgrade succeeded and the subscription was sent.
    pub fn on_open(&mut self, now: u64) {
        self.open_since = Some(now);
    }

    /// A real AIS record arrived (never a handshake, malformed frame or error envelope).
    pub fn on_data(&mut self, now: u64) {
        self.last_data = Some(now);
        self.failures = 0;
        self.health = Health::Live;
        self.last_failure = None;
    }

    /// Called on every tick of an open socket: true when it has been quiet for `recycle_ms` and
    /// must be closed (then report [`Failure::Quiet`]). Marks the feed stale after `stale_ms`.
    pub fn check(&mut self, now: u64) -> bool {
        let Some(open) = self.open_since else { return false };
        let since = self.last_data.map_or(open, |d| d.max(open));
        let quiet = now.saturating_sub(since);
        if quiet >= self.policy.stale_ms && self.health == Health::Live {
            self.health = Health::Stale;
        }
        quiet >= self.policy.recycle_ms
    }

    pub fn on_failure(&mut self, now: u64, failure: Failure) {
        self.open_since = None;
        let delay = match &failure {
            Failure::Auth(_) => {
                self.health = Health::AuthFailed;
                self.next_at = None;
                self.last_failure = Some(failure);
                return;
            }
            Failure::RateLimit { retry_after_ms, .. } => {
                self.failures += 1;
                self.health = Health::Reconnecting;
                retry_after_ms.unwrap_or(0).max(self.policy.rate_limit_floor_ms)
            }
            Failure::Transport(_) | Failure::Quiet => {
                self.failures += 1;
                match self.policy.backoff_ms.get(self.failures - 1) {
                    Some(d) => {
                        self.health = Health::Reconnecting;
                        *d
                    }
                    None => {
                        self.health = Health::Down;
                        self.policy.down_retry_ms
                    }
                }
            }
        };
        self.next_at = Some(now + delay.max(self.policy.min_gap_ms));
        self.last_failure = Some(failure);
    }

    /// Health as of `now` (a live feed turns stale after `stale_ms` without data).
    pub fn health(&self, now: u64) -> Health {
        if self.health == Health::Live && self.last_data.is_some_and(|d| now.saturating_sub(d) >= self.policy.stale_ms) {
            return Health::Stale;
        }
        self.health
    }

    #[cfg(test)]
    pub fn last_failure(&self) -> Option<&Failure> {
        self.last_failure.as_ref()
    }
}

/// Upstream text that names a credential problem.
pub fn is_auth_text(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    ["unauthori", "forbidden", "invalid api key", "api key is not valid", "invalid key", "bad api key", "authenticat", "api key required", "api key missing", "apikey"]
        .iter()
        .any(|p| t.contains(p))
}

/// Upstream text that names a rate limit or connection cap.
pub fn is_rate_text(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    ["rate limit", "rate-limit", "too many", "quota", "429", "concurrent connection"].iter().any(|p| t.contains(p))
}

/// Classify an error envelope or close reason.
pub fn classify_text(text: &str) -> Failure {
    if is_auth_text(text) {
        Failure::Auth(format!("AISStream rejected the API key: {text}"))
    } else if is_rate_text(text) {
        Failure::RateLimit { retry_after_ms: None, message: format!("AISStream rate limit: {text}") }
    } else {
        Failure::Transport(format!("AISStream error: {text}"))
    }
}

/// Classify a failed websocket upgrade by HTTP status and `Retry-After` (seconds or HTTP date).
pub fn classify_http(status: u16, retry_after: Option<&str>, now_unix_ms: i64) -> Failure {
    match status {
        401 | 403 => Failure::Auth(format!("AISStream rejected the API key (HTTP {status})")),
        429 => Failure::RateLimit {
            retry_after_ms: retry_after.and_then(|v| parse_retry_after_ms(v, now_unix_ms)),
            message: "AISStream rate-limited this key (HTTP 429)".into(),
        },
        s => Failure::Transport(format!("AISStream upgrade failed (HTTP {s})")),
    }
}

/// `Retry-After`: delta seconds or an HTTP date.
pub fn parse_retry_after_ms(value: &str, now_unix_ms: i64) -> Option<u64> {
    let v = value.trim();
    if let Ok(secs) = v.parse::<u64>() {
        return Some(secs.saturating_mul(1000));
    }
    let at = chrono::DateTime::parse_from_rfc2822(v).ok()?.timestamp_millis();
    Some((at - now_unix_ms).max(0) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive the policy against a server that fails every connection the same way, for `span_ms`
    /// of simulated time. Returns the connect times.
    fn simulate(failure: impl Fn(u64) -> Failure, span_ms: u64) -> Vec<u64> {
        let mut wd = Watchdog::new(Policy::default());
        let mut now = 0;
        let mut at = Vec::new();
        while now < span_ms {
            match wd.next(now) {
                Next::Connect => {
                    at.push(now);
                    wd.on_attempt(now);
                    wd.on_open(now);
                    wd.on_failure(now, failure(now));
                }
                Next::Wait(ms) => {
                    assert!(ms > 0, "a wait is never zero");
                    now += ms;
                }
                Next::Stop => break,
            }
        }
        at
    }

    #[test]
    fn ais_watchdog_auth_rejection_stops_retries() {
        let at = simulate(|_| classify_http(401, None, 0), 24 * 3_600_000);
        assert_eq!(at, vec![0], "one attempt, then nothing for a day");
        let mut wd = Watchdog::new(Policy::default());
        wd.on_attempt(0);
        wd.on_failure(0, classify_text("Api Key Is Not Valid"));
        assert_eq!((wd.next(10_000_000), wd.health(10_000_000)), (Next::Stop, Health::AuthFailed));
        assert!(wd.last_failure().unwrap().message().contains("rejected the API key"));
    }

    #[test]
    fn ais_watchdog_rate_limit_honours_retry_after() {
        let mut wd = Watchdog::new(Policy::default());
        wd.on_attempt(0);
        wd.on_failure(0, classify_http(429, Some("120"), 0));
        assert_eq!(wd.next(1_000), Next::Wait(119_000), "Retry-After 120 s");
        assert_eq!(wd.next(120_000), Next::Connect);
        // An HTTP date 300 s ahead.
        let now_unix = 1_790_000_000_000;
        let date = chrono::DateTime::from_timestamp_millis(now_unix + 300_000).unwrap().to_rfc2822();
        assert_eq!(parse_retry_after_ms(&date, now_unix), Some(300_000));
        let mut wd = Watchdog::new(Policy::default());
        wd.on_attempt(0);
        wd.on_failure(0, classify_http(429, Some(&date), now_unix));
        assert_eq!(wd.next(0), Next::Wait(300_000));
        // No (or a tiny) Retry-After: the floor, never the 5 s transport step.
        let mut wd = Watchdog::new(Policy::default());
        wd.on_attempt(0);
        wd.on_failure(0, classify_http(429, Some("1"), 0));
        assert_eq!(wd.next(0), Next::Wait(60_000));
        assert!(matches!(classify_text("Too many connections"), Failure::RateLimit { .. }));
    }

    #[test]
    fn ais_watchdog_transport_errors_back_off() {
        let at = simulate(|_| Failure::Transport("connection reset".into()), 3_600_000);
        let gaps: Vec<u64> = at.windows(2).map(|w| w[1] - w[0]).collect();
        assert_eq!(&gaps[..5], &[5_000, 15_000, 60_000, 300_000, 900_000], "ladder, then the slow retry");
        assert!(at.len() <= 8, "single-digit attempts per hour: {}", at.len());
        let mut wd = Watchdog::new(Policy::default());
        for t in [0, 5_000, 20_000, 80_000, 380_000] {
            wd.on_attempt(t);
            wd.on_failure(t, Failure::Transport("x".into()));
        }
        assert_eq!(wd.health(380_000), Health::Down);
        // Data resets the ladder.
        wd.on_attempt(1_280_000);
        wd.on_open(1_280_000);
        wd.on_data(1_281_000);
        assert_eq!(wd.health(1_281_000), Health::Live);
        wd.on_failure(1_300_000, Failure::Transport("x".into()));
        assert_eq!(wd.next(1_300_000), Next::Wait(5_000));
    }

    #[test]
    fn ais_watchdog_quiet_socket_is_recycled() {
        let mut wd = Watchdog::new(Policy::default());
        wd.on_attempt(0);
        wd.on_open(0);
        assert!(!wd.check(299_999), "handshake alone is not liveness, but not yet recycled");
        assert!(wd.check(300_000), "quiet for recycle_ms");
        wd.on_failure(300_000, Failure::Quiet);
        assert_eq!(wd.next(300_000), Next::Wait(5_000));
        // A live socket goes stale after 2 min of silence and is recycled after 5.
        wd.on_attempt(305_000);
        wd.on_open(305_000);
        wd.on_data(306_000);
        assert!(!wd.check(400_000));
        assert_eq!(wd.health(400_000), Health::Live);
        assert!(!wd.check(426_000));
        assert_eq!(wd.health(426_000), Health::Stale);
        assert!(wd.check(606_000));
    }

    #[test]
    fn ais_watchdog_no_busy_loop() {
        // A server that accepts and closes at once, every way it can fail, for a day.
        for failure in [Failure::Transport("closed".into()), Failure::Quiet, Failure::RateLimit { retry_after_ms: Some(0), message: "429".into() }] {
            let f = failure.clone();
            let at = simulate(move |_| f.clone(), 24 * 3_600_000);
            let min_gap = at.windows(2).map(|w| w[1] - w[0]).min().unwrap();
            assert!(min_gap >= 1_000, "{failure:?}: attempts {min_gap} ms apart");
            assert!(at.len() <= 24 * 60, "{failure:?}: {} attempts in a day", at.len());
        }
        let transport = simulate(|_| Failure::Transport("closed".into()), 24 * 3_600_000);
        assert!(transport.len() <= 4 + 24 * 4 + 1, "about four an hour once down: {}", transport.len());
    }
}
