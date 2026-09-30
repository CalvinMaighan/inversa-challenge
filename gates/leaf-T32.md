# Gates: T32 docs

Scope:
- README: run locally, architecture, decisions, tradeoffs, and the scaling story from PRD §17.
- docs/demo-script.md.
- docs/interview-notes.md: question choice, sources, alternatives considered.

- [ ] G1: the README has run, architecture, decisions and scaling sections
  CHECK: for s in "Run locally" "Architecture" "Decisions" "Scaling"; do grep -q "## $s" README.md || m=$((m+1)); done; echo "missing=${m:-0}"
  EXPECT: missing=0
  EVIDENCE: pending

- [ ] G2: the demo script and interview notes exist and are non-trivial (> 40 lines each)
  CHECK: wc -l docs/demo-script.md docs/interview-notes.md | awk '$1>40 && $2!="total"{n++} END{print "long="n}'
  EXPECT: long=2
  EVIDENCE: pending

- [ ] G3: every command in the README "Run locally" section was executed and works (manual: quote the outputs)
  EVIDENCE: pending
