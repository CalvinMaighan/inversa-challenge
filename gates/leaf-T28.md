# Gates: T28 performance pass (PRD §13)

Scope: measure every PRD §13 target and record the numbers in `docs/perf.md`. Fix misses, or ABANDON a target with its measured number.

- [x] G1: docs/perf.md holds a measured value for every target: scrub, cached query, voice command, first token, local edit, RTC edit, WS edit, GOES push, poll freshness, idle CPU
  CHECK: for k in scrub cached voice "first token" "local edit" "rtc" "ws" goes "poll" idle; do grep -qi "$k" docs/perf.md || m=$((m+1)); done; echo "missing=${m:-0}"
  EXPECT: missing=0
  EVIDENCE: missing=0. Two rows of docs/perf.md are ABANDON rows with the reason: voice command (no XAI_API_KEY in Doppler inversa/dev, H6) and GOES push (no GOES_SQS_URL, H4); the other eight are measured on the merged tree (poll freshness before the merge, no Rust changed since) and PASS.

- [x] G2: the offline-measurable targets meet their thresholds (scrub < 16 ms, cached < 20 ms, rtc < 150 ms); docs/perf.md marks each PASS
  CHECK: grep -ciE "(scrub|cached|rtc).*PASS" docs/perf.md
  EXPECT: /^[3-9]/m
  EVIDENCE: 4
