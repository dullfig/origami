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

## Interactive-pending checklist (needs a live terminal session)

1. Automatic sweep firing without `/compact` (and the `plugin` trigger value
   classic hooks receive) — blocked headlessly by F3.
2. Confirmation that interactive compaction actually replaces the live context
   (F1 is a resume artifact, not an interactive one — expected but unverified).
3. Canary re-run with non-distinctive needles (the librarian front-loads
   distinctive facts into stubs, F-canary above).
4. Negative control with the plugin disabled.
5. F2 re-check after the shouldSweep exclusion fix.
