# Gates: T33 deploy (requires explicit user authorization; blocked on H1 H2 H3 H8)

Scope:
- Build the release.
- Run the deploy workflow.
- Deploy the signal Worker with wrangler.
- Render the env with Doppler.

- [ ] G1: the live URL sends COEP require-corp
  CHECK: curl -sI https://inversa.calvinmaighan.dev | tr -d '\r' | grep -i cross-origin-embedder-policy
  EXPECT: /require-corp/i
  EVIDENCE: pending

- [ ] G2: the live health endpoint returns ok
  CHECK: curl -s https://inversa.calvinmaighan.dev/health
  EXPECT: ok
  EVIDENCE: pending

- [ ] G3: the live GraphQL endpoint answers the feeds query
  CHECK: curl -s -X POST -H 'content-type: application/json' -d '{"query":"{ feeds { source state } }"}' https://inversa.calvinmaighan.dev/v1/graphql
  EXPECT: /"feeds":\[/
  EVIDENCE: pending
