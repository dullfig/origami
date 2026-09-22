# Origami for codebases: granularity, fold-agents, and staleness

Source: the agentos session, 2026-09-21 (raw transcript: docs/agentos_convo.txt).
That session ran origami on itself (AgentOS, ~700k tokens of Rust) and derived,
independently, much of what the 2026-09-20 build session concluded — plus
substantial new design. This distills the conclusions as decisions. Cross-refs
to the chapter-folds addendum where the two conversations converge.

CONVERGENCE (two independent sessions, same conclusions — strong signal):
- "hydrate returns an ANSWER instead of a DOCUMENT" == the retrieval-handle
  reframing + fold-query agent (addendum v1.2).
- quote-drift across folds == the Dory / provenance-boundary problem.
- "invalidation must be VISIBLE in the rendering" == annotate the stub, never
  falsify the record.
- read-only fold-agents, don't eager-spawn == the fold-query-agent caveats.

## 1. Folding is for FOCUS, not FITTING (the reframe)

AgentOS is ~700k tokens total — it fits in a 1M window unfolded. So origami's
value on a codebase is NOT capacity. It is the attention argument from the
README: "every irrelevant token degrades the thinker; focused 300 tokens beats
full 128k history." That is a MEASURABLE claim — same harness, same task,
folded vs unfolded — and it is the claim to validate, not assume. Origami's
regime of interest is "what survives a fold, and whether the thing that
survives knows what it lost," not "make it fit."

## 2. Mixed-granularity folding (NEW)

Do not pick one fold level. Fold at DIFFERENT granularities in one context by
relevance: crate-level for the 20 crates you are not touching, function-level
for the two you are. The ladder (agentos numbers, ~40 tokens/stub):

  crates      25     ~2k tokens (≈ what CLAUDE.md already holds)
  files      171     ~9k tokens
  non-test fns 1,450 ~58k tokens
  all fns    2,854   ~114k tokens

- Excluding tests is free and halves the index (1,404 of 2,854 are #[test]).
  A navigational index never needs test_boundary_burst.
- Function-level across a whole repo is NOT the default: 114k of index is a
  whole session's budget spent before doing anything. File-level is 12x
  cheaper and captures most navigational value ("which file", then read it).
  Function-level earns its cost on cross-cutting tasks: blast radius,
  who-calls-what, does-this-helper-exist.

## 3. Invalidation is the real argument for fine granularity (NEW, sharp)

Better than the compression argument: "how much does one edit DESTROY." Edit
one function in a 600-line file and a FILE-level fold goes entirely stale — you
lose twenty other functions' summaries for nothing. A FUNCTION-level fold
invalidates one entry of 2,854 and leaves the rest valid. So the granularity
choice is driven by edit-blast-radius, not token savings.

## 4. Stale folds — the central coding problem, and its design (NEW, load-bearing)

The moment writes enter the loop, origami acquires the exact bug it was built
to fix: the main agent edits a file, that file's fold is now stale, and a
question ten minutes later gets a confident answer about code that no longer
exists. Single-writer (only the main agent mutates) makes it TRACTABLE — you
always know when to invalidate and what — but it must be wired deliberately.

### 4a. Folds are not uniformly invalidatable — classify at fold time

  file read (Read, cat, sed -n)     stale when that file changes    cheap: path+hash
  search result (grep, rg)          stale when ANY file in the set  hard: wide blast radius
                                    changes
  command output (git log, test,    stale on almost any change      not trackable: it's a
  build)                                                            timestamped observation
  pinned read (git show <sha>:file) NEVER                           immutable — mark it, exempt it

The last row matters: a meaningful fraction of folds are immutable by
construction and should skip the whole machinery. (Ties to origami's fold
states: an immutable fold is a distinct kind.)

### 4b. Two detection mechanisms — need BOTH

- HOOK THE WRITER (precise, instant, zero false positives): the main agent's
  Edit/Write tool knows the exact path; on write, look up folds covering that
  path and mark them. Blind to changes outside the loop.
- HASH SWEEP (comprehensive, coarse): catches out-of-loop changes — IDE edits,
  a build regenerating a file, git checkout, another Claude session. Fold-time
  record path + CONTENT HASH; on sweep re-stat and compare. Use a HASH, not
  mtime+size — a one-character code edit preserves size, and that is the common
  case. (origami already has contentHash from delta sweeps.)

### 4c. Three tiers of staleness (the seam problem again; treesitter + ripwire make it real)

Text-level invalidation is necessary but not sufficient:
- Body changed, signature SAME  -> callers are fine; do not touch them.
- Signature or type CHANGED     -> callers' text is unchanged but their folds'
                                   DESCRIPTIONS may now be wrong; flag SUSPECT,
                                   do NOT hard-invalidate.
- Deleted or renamed            -> hard invalidate, and callers are suspect.

### 4d. THE INVALIDATION MUST BE VISIBLE IN THE RENDERING (emphatic)

Marking a fold stale on disk does NOTHING for the model — if the stub still
reads as a confident advertisement, the model uses it as one. The stub itself
must carry it:

  [origami fold-012 · ⚠️ STALE — file changed after your edit at 07:23 · hydrate for current]

"A silently-stale fold is strictly worse than no fold, because it converts
'I don't know' into 'I confidently know something outdated.'" (This is the
addendum's "invalidation visible in the projection, not just the store" made
concrete — same rule as the banner's provenance bullets.)

## 5. Fold-agents: hydrate returns an ANSWER, not a DOCUMENT (NEW depth on v1.2)

A read-only subagent handed a fold id answers questions about it; the fold
content NEVER enters the orchestrator's context. This removes transport cost
entirely (vs hydrate pulling 28k tokens for one question about a 110KB fold)
and makes anchor-slicing unnecessary rather than merely better.

But it hits a wall: BUGS LIVE IN THE SEAMS, NOT THE CHUNKS. An agent owning
only fold-A has cross-chunk blindness — 43 agents each report "not me" and the
bug is in the handshake nobody owns. The fix is the split applied all week:
INTERFACES CENTRAL, IMPLEMENTATIONS DISTRIBUTED. The orchestrator holds the
signatures and call graph (cheap — the edges), reasons about the SEAM (where
the bug is), and dispatches body-level questions to whoever owns the
implementation. (ripwire = who-calls-what; treesitter = symbol extraction —
both already exist as capabilities.)

Cautions:
- Don't eager-spawn: 43 folds != 43 agents. Spawn ON SUSPICION, from the call
  graph, not on fold creation.
- Read-only is most of the value and none of the risk: question-answering, not
  editing. 43 agents writing to one tree is the coordination problem.
- Star topology, not mesh: agents report to a coordinator (audit trail,
  platform in every hop). Peer-to-peer is n^2 and breaks provenance.
- Fold-agents can be Haiku-class: reconnaissance only needs to RANK ("more
  likely in your chunk than his") — relative ordering tolerates noise a
  generator can't (the two-bar framework: recon = Bar 1, edit = Bar 2).

THE CHEAP TEST (before any swarm infra): give ONE subagent ONE fold, ask three
questions you'd otherwise hydrate for, compare answer quality and token cost
against just pulling the fold. Wins -> the architecture question is worth
having. Loses -> you saved building a swarm, learned in an afternoon.

## 6. Edit from the ARTIFACT, never from a REPORT (invariant)

The fold-agent's answer is a paraphrase — lossy by design, that's why it's
cheap. Editing from a paraphrase is the quote-drift problem with write
consequences. So: the agents (Bar 1, cheap, parallel) RANK where the problem
is under blindness; when the main agent has a plan, it HYDRATES the pertinent
files (Bar 2, exact, serial) and edits from the real bytes.
- Hydrate WIDER than the plan: pull callers AND callees of the change site
  (blast radius, ripwire), not just the site — cheap relative to editing the
  wrong thing.
- Be willing to THROW THE PLAN AWAY at hydrate time: the plan came from
  reports; the artifact may contradict them. When it does, the system is
  WORKING (the artifact corrected the paraphrase) — but only if the main agent
  treats the mismatch as information, not an obstacle to route around. Make it
  an explicit step: after hydrating, check the plan's premises against the real
  code before the first edit. (Same failure mode as accepting an unverified
  code review: cheap lossy proposes, expensive exact disposes, works only if
  the expensive step is allowed to overrule.)

## 7. Stale fold-agents: KILL, don't re-brief (NEW)

If a fold-agent holds content and the fold goes stale, the agent is stale — the
old text sits in its context and you cannot mark an agent stale. Kill and
respawn (truncate-and-restart, easy) rather than surgically replacing the stale
span in a live context (the splice problem, hard). Respawn is cheap: the
agent's whole job is to re-read one fold and answer.

## 8. Two hazards flagged for beta scrutiny

- QUOTE-DRIFT (provenance): quotes degrade into paraphrases across folds and
  nothing flags it. The banner's "never state details from the stub alone"
  covers the STUB; it does NOT cover the model quoting its OWN earlier prose
  ABOUT folded content, which reads as first-hand and isn't. Mitigations: the
  stub records which verbatim spans the assistant reproduced; OR anything
  presented as a quote after a fold is re-verified before it's load-bearing.
- REDUNDANCY-VERDICT (silent total loss): the librarian marking one result a
  "subset / redundant" of another is DEDUPLICATION, not compression. Failure
  asymmetry — compression loses detail VISIBLY (the stub is shorter); a wrong
  redundancy verdict loses an ENTIRE artifact INVISIBLY, with no diff to
  recover. Highest-value place to point beta scrutiny.

## 9. Strategic: origami is the token-level prototype of composable-KV

origami == project two-tier memory with a token substrate (synopsis always
scanned, source drilled on demand). And it is the TOKEN-LEVEL prototype of the
composable-KV idea: fold = evict from context + keep a stub; unfold = re-insert
+ re-prefill; the composable-KV version keeps the COMPUTED ATTENTION instead of
re-prefilling — same policy, cheaper mechanism. The ordering is lucky: if
origami's fold policy proves out at the token level, the KV version stops being
a speculative build and becomes a performance optimization of a validated
policy. Reason enough to let origami run first.

## Priority additions to the roadmap (from this session)

1. Stale-fold invalidation (section 4) — the load-bearing coding fix; wire the
   writer hook + hash sweep + VISIBLE stale stubs. This gates trusting origami
   on any edit-heavy session (agentos).
2. The cheap fold-agent test (section 5) — one agent, one fold, three
   questions, before any swarm.
3. Fold-kind classification (4a) incl. the immutable/pinned exemption.
4. Mixed-granularity folding (2) + function-level via treesitter, argued by
   invalidation blast-radius (3) not compression.
5. The two hazards (8) as explicit beta-scrutiny targets.

## Cheap-test RESULT (2026-09-21, run): fold-agent PASSES decisively

Setup: one read-only sonnet subagent given one fold (runbook.md, 74,626 chars
≈ 18,657 tokens), three questions — two point-lookups (shard 17 -> 57s, shard
23 -> 85s) and one SYNTHESIS requiring the whole fold (largest/smallest/count
of 24 shard drain intervals). Ground truth verified against the file.

Result: 3/3 CORRECT, including synthesis (shard 13 @ 103s largest, shard 21 @
11s smallest, 24 sections), with exact lines quoted (grounded, no confabulation
in-scope). Orchestrator context cost: ~250 tokens (the agent's returned report)
vs 18,657 tokens to hydrate the fold — ~75x leaner for equal-or-better answers.
Agent internal burn 65.6k tokens / 8.7s, isolated off the orchestrator's
context and critical path (free in dollars on a fixed plan).

BONUS FINDING (the thesis, live): on Q3 the ORCHESTRATOR (setting up the test)
computed shard 13 = 100 from the formula in its head; the AGENT that actually
read the file returned 103; the file says 103. The reader of the evidence beat
the reasoner-from-memory — exactly what origami exists to enforce.

Untested corners (the natural next probes): (a) NEGATIVE CONTROL — a question
whose answer is NOT in the fold; does the agent say "not in my fold" or
confabulate? The safety question. (b) HAIKU — do point-lookups and the
synthesis hold at haiku-class (the economics claim)? Verdict: build the
fold-query agent; the architecture question is worth having.
