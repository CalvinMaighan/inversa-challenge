# Gates: T35 live feed verification (blocked on T33 H4)

Scope:
- Every feed chip is nominal, or is lagging with a stated reason.
- One GOES push is observed end to end, from SQS delivery to a visible frame.

- [ ] G1: live feeds report no source down, except NWWS when it is unconfigured
  CHECK: curl -s -X POST -H 'content-type: application/json' -d '{"query":"{ feeds { source state note } }"}' https://inversa.calvinmaighan.dev/v1/graphql | grep -o '"state":"DOWN"' | wc -l | tr -d ' '
  EXPECT: /^0$/m
  EVIDENCE: pending

- [ ] G2: GOES push to a visible frame in under 60 s (manual: quote the log timestamps for SQS receive, commit and FramesUpdated)
  EVIDENCE: pending

ABANDON: G1 blocked on T33 (no live URL)
ABANDON: G2 blocked on T33 and H4 (no deploy, no GOES SQS queue)
