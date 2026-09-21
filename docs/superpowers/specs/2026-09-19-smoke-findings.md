# Origami smoke-test findings — 2026-09-19

Environment: Claude Code 2.1.278, Windows 11, plugin loaded from the worktree via
`--plugin-dir`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Driven HEADLESSLY: a scripted
sequence of `claude -p` / `claude -p -c` turns (model sonnet) in a scratch project
holding four generated files (~294k chars ≈ 73k tokens) with two planted canaries.
Headless driving found real things an interactive run would also hit, but it has one
big artifact of its own (finding F1) — items marked **interactive-pending** still
need a live session pass.

## What fired when (observed sequence)

1. Turn 1 read all four files (7 Read results — the harness paginates >25k-token
   reads, so 4 files became 7 results). Turns 2–4: filler chat.
2. `turn.complete` trigger: fires every turn, main thread only. From turn 4 on it
   decided `{sweep:true, aggressive:false}` — correct (mass ≈ 73k ≥ 20k, age ≥ 3).
3. **`$.session.compact()` is refused in headless sessions** (engine message:
   "not available in a headless (-p / SDK) session yet: compaction here runs inside
   a turn (a /compact prompt); catch it and carry on"). Origami's catch handled it
   exactly as designed: logged via `$.ui.log`, fell through, no crash, retried next
   turn. Consequence: **automatic sweeps are interactive-only for now**; in headless
   sessions `/compact` as the prompt runs the full sweep instead.
4. `/compact` sweep #1: 75,599 → 1,208 tokens (**98.4% reduction**), 7 folds
   created, librarian 75,680 tokens in / 510 out (one haiku call), bodies under
   `.claude/origami/folds/`, JSONL log record complete (`trigger:"manual"`,
   `foldsActive:7`). Stubs and the `[ORIGAMI v1.0.0 …]` banner persisted into the
   session transcript. Banner + synthetic labeled ack accepted by the engine/API at
   the top of the rebuilt context — no rejection (banner acceptance CONFIRMED).

## Canary outcomes (scoring per plan Task 10 step 3)

- **The librarian front-loads distinctive facts into anchor text.** Both canaries
  leaked into the stubs themselves: `[rate limiting 7341/hr](hydrate://fold-001#rate-limit)`
  and `[warehouse threshold 421 units](hydrate://fold-004#warehouse)`. The canary
  question ("exact rate limit?") was answered correctly **from the stub, with no
  tool call**. This defeats the needle-behind-a-fold test as designed (the needle
  ended up ON the fold), and is double-edged: excellent recall for salient facts,
  but stub quality now carries correctness risk — a wrong number in a stub would be
  quoted confidently. The unlinked-concept probe is impossible when the librarian
  anchors everything distinctive. **Interactive-pending: re-run with canaries made
  non-distinctive (bland values in bland prose).**
- **Family-1 cheap observed and CAUGHT**: asked to quote line 200 verbatim, the
  model re-Read the file instead of hydrating; `origami.log` gained
  `{"event":"missed_hydrate","foldId":"fold-001",...}` with the exact inputKey.
  The degradation health metric works.
- **Confabulated-citation risk (new failure family)**: the canary answer cited
  exact line numbers (181/182). Later evidence (F1) suggests the model may have
  had raw context, so this specific instance is unscored — but the pattern to
  watch interactively is: value correctly sourced from a stub, plus a fabricated
  precision garnish (line numbers, quotes) the stub cannot support.
- **BETA DUTY works.** When told to follow a hydrate link while (per F1) its
  context actually held full content, the model explicitly reported the
  anomaly to the user ("every earlier tool result reads as full content, not as a
  stub … that mismatch is the anomaly you asked me to flag") instead of playing
  along. The banner earns its place.

## Tool cycle (all mechanics verified end-to-end)

- `mcp__origami__hydrate` returns the full body through the `{ result }` envelope;
  oversized results get persisted by the harness to a tool-results file with a 2KB
  preview, which the model then Greps — workable. Anchor argument logged
  (`"anchor":"backoff"`).
- Second hydrate → pin: notice text verbatim as designed, `hydrations:2`, state
  `pinned`.
- Sweep with a pinned fold → `restores:1`; the restored slot is **byte-exact**
  (no `# fold …` header, no `<<<origami:body>>>` delimiter anywhere in the
  transcript; the header appears only as hydrate-output presentation).
- `mcp__origami__unpin` → "fold-003 unpinned: …", state reset, logged.
- Subagent scope: an Agent-spawned subagent's `turn.complete` arrived with its
  `agentId` and was passed through untouched (no sweep decision run); no stubs in
  its transcript.

## Findings

**F1 (headless artifact, P1 for headless use only): `-p -c` resume rebuilds the
model context from the RAW transcript, ignoring the compaction rewrite.** Evidence:
post-sweep API usage showed `cache_read_input_tokens: 135,680` (a folded context
would be ~2k); the model testified it saw full tool results alongside the banner;
post-sweep `shouldSweep` kept computing the original 73k mass. Stubs and banner
ARE in the transcript file, but resumed context contains the originals too.
Consequences: headless post-sweep behavior scoring is unreliable, and repeated
`/compact` runs refold the same originals under fresh ids (observed: sweep #2
`foldsCreated:6`, sweep #3 `foldsCreated:13`, `foldsActive:26` — duplicate folds
accumulate). Interactive sessions likely replace the live context properly —
**interactive-pending confirmation**. Worth reporting upstream on the function-hooks
issue (anthropics/claude-code#91870) once confirmed interactive-clean.

**F2 (real defect, fix before/at merge): `$.session.messages()` returns the raw
uncompacted transcript** (at least in resumed headless sessions), so after a
successful sweep the trigger keeps seeing the original mass and deciding
`sweep:true` every turn. Headlessly this is harmless (compact() refuses); in an
interactive session it would dispatch `$.session.compact()` after every turn until
the cooldown engages via the runSweep skip path — and the nothing-to-fold skip may
record a mass the cooldown can't use. Cheap robust fix: `shouldSweep` should
exclude the toolUseIds of ALL non-evicted folds (not just pinned), which zeroes
already-folded mass regardless of which transcript view `messages()` returns.

**F3 (engine limitation, documented): `$.session.compact()` unavailable headless.**
Trigger detects, logs, falls through cleanly — the fallback contract held on every
one of ~8 refusals. README Coexistence updated.

**F4 (coexistence, observed): classic PostCompact hooks fire on origami sweeps
with matcher/trigger value `manual`** for `/compact`-initiated sweeps
(debug log: `PostCompact:manual`). They cannot distinguish an origami lossless
sweep from stock manual compaction by trigger alone. The expected `plugin` value
for automatic sweeps is **interactive-pending**. README updated with gating advice
(gate classic hooks to `auto`).

**F5 (environment bug, not origami): Claude Code 2.1.278 rejects PostCompact
`hookSpecificOutput.additionalContext`** — the schema validator's hookEventName
union omits PostCompact, so a user-level PostCompact context hook fails validation
despite the event firing. Affects the user's own post-compaction-protocol hook.

**F6 (observation): pagination interacts well with folding** — a >25k-token file
becomes two Read results and two independent folds; the librarian stubbed both
coherently (page ranges in the stub text).

**F7 (stub quality, verbatim examples above): 4-anchor grammar followed exactly,
concept slugs sensible, sizes honest (line counts), zero parse failures across
3 librarian calls (sonnet-driven session, haiku librarian).** `parseSweepReply`'s
regex brittleness never triggered.

## Log excerpts (verbatim)

```
{"event":"sweep","trigger":"manual","aggressive":false,"tokensBefore":75599,"tokensAfter":1208,"librarianInputTokens":75680,"librarianOutputTokens":510,"foldsCreated":7,"restores":0,"foldsActive":7}
{"event":"missed_hydrate","foldId":"fold-001","tool":"Read","inputKey":"...\\smoke\\src\\gateway.ts"}
{"event":"hydrate","foldId":"fold-003","hydrations":1,"originAge":8,"anchor":"backoff"}
{"event":"hydrate","foldId":"fold-003","hydrations":2,"originAge":8}
{"event":"unpin","foldId":"fold-003"}
{"event":"sweep","trigger":"manual","aggressive":false,"tokensBefore":79626,"tokensAfter":37581,...,"foldsCreated":6,"restores":1,"foldsActive":12}
```

## Interactive smoke results (2026-09-19 evening, run live with Dan)

Fixture: C:\src\origami-smoke, ~71k tokens across four files; one distinctive
canary (rate limit 5217, gateway.ts:181-182) and 24-per-file BLAND per-shard
values (needle: runbook shard 17 = 57 seconds, runbook.md:264). Ground truths
held by the controller; the test session was never told them.

Every interactive-pending item closed:

1. **Automatic sweep: PASS.** Fired on its own at the age gate, no `/compact`:
   `trigger:"plugin"`, 73,638 → 1,277 tokens (98.3%), 5 folds, one 73k-token
   haiku call (~15s inline at turn end — the model announces the pause).
   Classic hooks receive `plugin` for automatic sweeps and `manual` for
   /compact sweeps, exactly as the spec predicted — they CAN gate on it.
2. **Interactive compaction genuinely replaces the live context: PASS.**
   Model testimony post-sweep: banner first, labeled synthetic ack second,
   all reads stubbed, no residual content. F1 is confirmed to be a
   headless-resume artifact only.
3. **Bland-needle canary: GREEN, textbook.** For both needles the model read
   the stub, recognized insufficiency, ToolSearch-loaded the deferred
   `mcp__origami__hydrate` schema on its own, hydrated with fold id AND
   anchor (`anchor:"ratelimit"`, `anchor:"shard-ref"`), picked the correct
   runbook chunk (fold-004 vs the offset-328 fold-005) from anchor topics
   alone, and answered both ground truths exactly (5217 @ 181-182; 57s @ 264)
   with real citations from hydrated bytes. Stub-inlining of distinctive
   facts (headless F-canary) did NOT recur — it is stochastic; the hydrate
   path is the reliable one.
4. **Pin cycle: PASS end-to-end.** Second hydrate → pin notice verbatim;
   next sweep restored the body inline (`restores:1`, tokens 5,036 → 22,889 —
   context growth by design, reduction gate correctly bypassed); unpin →
   the automatic trigger refolded it 4 seconds later at turn.complete.
5. **F2 fix held**: exactly one sweep per fold-worthy state change; no
   per-turn re-trigger, no trigger-skipped errors.
6. **Negative control**: waived — F10 below demonstrated stock behavior
   in-situ, on the same context.

## New findings from the live run

**F8 (behavioral, novel — the "Dory effect" / false-confession failure).**
Post-sweep, the model cannot distinguish "I said X because I saw it (now
folded)" from "I confabulated X". BETA DUTY's honesty pressure then produced
a FALSE CONFESSION: it retroactively indicted its own true, evidence-based
pre-fold statements ("my confirmation was unsupported") because the receipts
were folded — and later correctly retracted the confession, deriving the fix
itself: "the only stable record of what I saw before is what I wrote in my
own earlier messages." Banner wording should carry exactly that: pre-fold
statements were made with full content in view; distrust only claims sourced
from a stub alone. Also add "(this notice is updated in place at each sweep)"
— the model flagged the fold count at index 0 as looking retroactively
injected, which it is.

**F9 (UX): the pin notice is appended AFTER the body**, so when the harness
persists an oversized hydrate result it lands at the tail of the saved file
and only a truncated preview shows inline — the model found it only because
it was told to look. Fix: prepend the notice (or emit at both ends).

**F10 (coexistence, the sharpest finding): stock compaction is destructive
to a folded context.** Sequence observed: automatic sweep refolded everything
→ user typed /compact → runSweep found nothing to fold and no restores →
designed manual fallback passed through to stock compaction → the summarizer
WIPED the banner, every stub, every hydrate link, and all tool results,
leaving canary values only as unverifiable summary prose. Fold bodies and
index remain intact on disk, but the model has lost every recovery path —
practically orphaned folds. Consequences:
  - The manual nothing-to-fold fallback should SKIP (with "origami: nothing
    to fold") when live folds exist, instead of passing through — needs a
    spec ruling; the current behavior implements the spec's fallback matrix
    faithfully but the matrix itself is wrong for this case.
  - v1.1 candidate: post-stock-compaction fold-index resurrection — on the
    next sweep or SessionStart:compact, re-inject a compact index message
    (fold ids + stubs from the store) so recovery links survive summarization.
  - The next origami sweep's reconcile will mark the wiped folds 'evicted'
    (correct bookkeeping; bodies stay on disk).

**F11 (residual F2 sibling, P3): spurious aggressive mode.** The post-unpin
automatic sweep ran `aggressive:true` in a ~24k-token context: `liveTokens`
in shouldSweep still counts the raw `$.session.messages()` view (~150k),
though the F2 fix corrected the candidate-mass side. Fix: discount excluded
folds' mass from liveTokens too (or derive the budget check from the live
view). Effect is mild over-folding (fold age floor drops to 1).

**F12 (engine observations, not origami):** (a) `$.session.root()` project
key prefix confirmed working live (`origami@1d8s4ik/` in store keys); (b) the
SessionStart:compact hooks fire TWICE per compaction (duplicate superpowers
context observed by the model, duplicate hook-success lines in the debug
log); (c) a PreCompact hook reporting "failed: Hook cancelled" did not stop
compaction; (d) the user's relocated post-compaction-protocol hook (moved to
SessionStart:compact after F5) works — but fires on origami sweeps too, where
its "your context was just summarized" text is wrong; it cannot distinguish
trigger values the way PostCompact matchers can.

**F13 (transcript semantics, raised by ringhub-integration; VERIFIED on the
live session's JSONL): origami sweeps do NOT rewrite the transcript.** A
hook-returned `{messages}` result rides the same append-boundary machinery as
stock compaction: the folded projection is appended after a boundary and the
verbatim history endures beneath. Proof: the interactive session's transcript
simultaneously holds content that exists ONLY in the raw Read results (9 hits
for a shard value never discussed or stubbed), 35 stub markers, 11 banner
copies, and the stock-compaction records. The JSONL stays the lossless
artifact tier; fold bodies are a SECOND copy, never the sole survivor;
origami edits the projection, never the record. Corollary: headless F1 (raw
resume) exists precisely because the originals endure — resume semantics for
a folded session (does interactive --resume boot folded?) remain the one
untested cell.

**F14 (safety surface, observed live 2026-09-20 on THIS dev session — novel):
compaction is a decontextualizing event that can trip dual-use safety
gating.** During a sweep of a long, security-adjacent session (prompt-injection
discussion, the system prompt's own C2/credential/exploit vocabulary, an
`autoMode` config dense with prod/secrets/credential keywords, an
"how would you fabricate a fake past" thread), the main model was gated and
the harness SWITCHED it from Claude Fable 5 to Opus 4.8 mid-conversation
(Fable carries extra dual-use safety measures Opus does not — stated in its
system prompt). A second layer (the auto-mode Bash classifier) separately
denied a compound git command in the same window.
  - Mechanism (hypothesis, strongly fits): the librarian re-submits ~100k
    tokens of the spiciest tool-results to haiku as a BARE summarization
    prompt, stripped of the surrounding conversational arc that made them
    benign. A long legitimate session accretes exculpatory context the
    safety layer reads as a whole; extraction throws that context away, so
    the classifier sees a context-free blob of flagged terms. The librarian
    honors its "sees full content" invariant while the CLASSIFIER sees
    decontextualized spice. Compaction is therefore a safety-surface event:
    re-projecting context re-submits content to classifiers without the
    frame that legitimized it.
  - Not an origami bug: a `$.model.complete` refusal is just another
    librarian failure the fallback matrix already catches — but it explains
    why content-heavy sweeps on security-adjacent sessions may fail where
    the code is flawless, and why a sweep can coincide with a model switch.
  - Design response (v1.1 item 9 in the addendum): a framing preamble on the
    librarian prompt restoring the exculpatory frame ("you are summarizing
    tool output from an authorized development session for context
    management"). Does not weaken any real safety property — it restores
    context the extraction removed, rather than suppressing a signal.

## Remaining before/after merge

- Dan's ruling on F10's fallback-matrix change (manual + nothing-to-fold +
  live folds → skip).
- F11 one-liner alongside it.
- F8/F9 banner + notice wording tweaks (small, post-merge acceptable).

**F15 (platform floor, measured 2026-09-20 via a no-op plugin): Claude Code's
compaction machinery costs ~3ms; the entire sweep cost is the librarian
round-trip.** A minimal plugin that claims `session.compact` and returns the
messages unchanged (zero model work) settled the dispatch in 3.0ms (debug:
"session.compact ... settled in 3.0ms (worker hop, next() included)"), and the
engine logged "a hook's messages stand ... core never ran" — empirically
confirming that a hook returning a result BLOCKS the stock summarizer. Total
`/compact` wall-clock was 2.3s, dominated by `claude -p` process startup; the
compaction itself is 3ms. Consequence: platform overhead is negligible, so
every second of a real sweep is haiku prefill+generation. This is the
motivation for the v1.2 mechanical-fold pivot (chapter-folds addendum): if the
fold is a structural transform needing no LLM, the critical path drops from
~20s to ~3ms and the librarian becomes a background stub-beautifier.
