# Spec addendum: chapter folds, the compaction endgame, and the fallback-matrix revision

Date: 2026-09-19 (evening, post-smoke). Author: controller session with Dan.
Status: fallback-matrix revision + session-start warning + banner wording are
v1 (implemented on this branch); chapter folds are the accepted v2 design.

## The problem (smoke finding F10, generalized)

Origami folds bulky stale TOOL RESULTS. It never touches conversation text,
the protected recent window, or pinned folds. A session that approaches the
window limit despite sweeps is therefore mostly dialogue — and for that
residue the v1 behavior was the worst case: the reduction gate fails, the
sweep passes through, and the stock summarizer WIPES the banner, every stub,
and every hydrate link. Bodies survive on disk; the model loses all paths to
them. Observed live: one `/compact` on an already-lean folded context
destroyed the whole recovery surface.

## v1 ruling: fallback-matrix revision (F10) — implemented

Let "live folds" mean store entries in state `folded` or `pinned`.

| Situation | Old behavior | New behavior |
|---|---|---|
| `manual` (/compact), nothing to fold or insufficient, live folds EXIST | pass through → stock summarizer wipes stubs | **skip** with `origami: nothing to fold — N live folds already active; stock compaction would destroy their stubs` |
| `manual`, nothing to fold, NO live folds | pass through | pass through (unchanged — stock is harmless with nothing to lose) |
| `auto` (window genuinely full), origami cannot reduce | pass through bare | pass through with **fold-index insurance**: the event handed to `next()` carries one appended user message listing every live fold (`id — stub`) so the summary has explicit, list-shaped material to preserve the recovery links from |
| `plugin` | skip (unchanged) | skip (unchanged) |

Rationale: a user's /compact must not silently destroy what origami built;
but `auto` fires because the window is truly full, so origami must never
block it — it can only make the summarizer's input carry the index.

Also in this wave:
- **F11**: `shouldSweep`'s `liveTokens` now discounts tool results whose
  toolUseId belongs to a non-evicted fold (the same exclusion the mass
  calculation applies), so aggressive mode cannot engage from an
  already-folded raw transcript view.
- **F8**: banner wording gains: "(this notice is updated in place at each
  sweep)" and "Statements you made before a fold were made with the full
  content in view; your own earlier messages are your record of what you
  saw. Distrust only claims sourced from a stub alone." (The live model
  derived that rule itself after a false-confession episode.)
- **F9**: the pin notice is prepended before the hydrate body (and repeated
  at the tail), so it survives oversized-result preview truncation.
- **Session-start warning**: origami's `session.start` hook now injects a
  short standing notice (independent of the sweep-time banner, which only
  exists after the first sweep): this session's context is a RENDERING that
  origami may rewrite between turns — tool results can fold to stubs and
  return; the top-of-context banner appears once folds exist; nothing is
  ever lost, only re-rendered. This kills the pre-first-sweep confusion
  observed live ("no banner — is the hook misplaced?") and pre-arms the
  model against the Dory effect.

## v2 design: chapter folds (accepted, not yet implemented)

Extend the fold/stub/hydrate contract from tool results to CONVERSATION
TURNS. When tool-folding cannot bring the working set under budget:

1. Select the oldest contiguous turn range beyond the protected window
   (never the first message, never pinned content).
2. Write the turns VERBATIM to a fold body on disk (same store, same
   lifecycle: folded/pinned/evicted).
3. The librarian — which sees the full turns, per the librarian invariant —
   writes a narrative stub with anchor links:
   `[origami fold-NNN · turns 4-19 folded] Debugged the auth flow:
   [root cause](hydrate://fold-NNN#cause), [chosen fix](hydrate://fold-NNN#fix),
   [rejected alternatives](hydrate://fold-NNN#alts)`
4. The range collapses to a single stub message in the rebuilt context.
   Hydrate returns the exact turns; two hydrations pin the chapter, and a
   pinned chapter is spliced back verbatim by the next sweep; unpin refolds.

Consequences:
- The summary is a lossy VIEW over a lossless RECORD — compaction stops
  being an event and becomes deeper folding. The stock summarizer never
  runs on the main thread again (the `auto` row above becomes: chapter-fold
  until under budget, answer the event).
- The Dory effect is structurally solved: the model can always recover what
  it actually said.
- Anchor-hydration telemetry extends naturally to chapters (which concepts
  pull models back into which conversations — the prefetch training signal).

## v1.1 design: resume re-projection (accepted, not yet implemented)

Problem: a resumed session boots from the transcript's verbatim tier (F1
observed this headlessly; interactive --resume is the untested cell), so the
model sees raw history instead of the folded projection, and re-folding today
would re-pay the librarian and mint duplicate fold ids.

Design (Dan, 2026-09-19 evening) — three small pieces, no transcript reading:
1. **Stub-reuse in runSweep**: a candidate whose toolUseId matches an
   existing non-evicted fold reuses that fold's id and stored stub verbatim —
   no librarian call, no new putFold (body already on disk). Re-folding a
   known result becomes free and id-stable, and the reconcile stops evicting
   resumed folds.
2. **Stub-presence refinement to the F2/F11 discounts**: shouldSweep must
   discount a fold's mass only when its STUB is present in the current view
   (foldIdsPresent), not merely because the fold exists in the store. As
   shipped, the store-existence predicate suppresses the trigger on a
   resumed-raw context (originals visible, stubs absent, mass discounted to
   ~0) — the discount and the self-heal fight each other. With the
   refinement, a raw boot has full visible mass, the first turn.complete
   fires the sweep, and piece 1 makes the re-projection instant.
3. **Optional session.start(resume) nudge**: when the start source is
   `resume` and live folds exist whose stubs are absent from the booted
   view, call `$.session.compact()` immediately (interactive only; the
   headless refusal is caught as usual) so the user never sees the raw
   flash. Without the nudge, piece 2 alone self-heals within one turn.

v1.1 refinements from the second live session (2026-09-19, ~21:35-21:47 —
which also FIELD-VERIFIED the whole v1 wave: session-start notice quoted by
the model unprompted; banner bullet deployed verbatim; reconcile evicted the
wiped session's orphan entries, banner counted only live folds; automatic
plugin sweep 76,258→3,954; and /compact with 5 live folds REFUSED with the
guard message — the same command that had wiped the prior session):
4. **The stub-presence predicate belongs in the missed-hydrate observer
   too**: a Read matching a fold whose stub is NOT present in the current
   view (wiped by stock compaction, or pre-resume-reprojection) is a FALSE
   POSITIVE of the health metric — observed live (old fold-004 scored a
   miss against a model that had no stub to hydrate from). One predicate,
   three consumers: trigger discount, resume re-projection, observer.
5. **Banner bullet needs a provenance boundary**: "your own earlier messages
   are your record" holds within an unbroken session, but a stock-summary
   boundary launders provenance — after one, part of "your record" is
   secondhand paraphrase that can confabulate (observed live: the summary
   invented a nonexistent "shard-24 coordination section", caught by the
   model on re-read). Reword to "within this session, since the last
   summary" — and note this is chapter folds' strongest argument: a chapter
   stub's backing record never degrades to paraphrase.

6. **Banner architecture split (Dan, 21:50 — accepted for v1.1, supersedes
   the count-in-banner and its "(updated in place)" note):** the top banner
   becomes STATIC — rules only (rendering warning, hydrate discipline, BETA
   DUTY, the pre-fold-record rule, the rewritten-in-place bullet), written
   once at the first sweep and never touched again (also a prompt-cache win:
   today every sweep rewrites index 0 and busts the cache from token zero).
   The mutable part moves INLINE: each sweep appends a small marker pair at
   the sweep point — "[origami sweep: folded fold-NNN…, restored …; N folds
   now active. Content discussed above may now render as stubs.]" + tiny
   ack — historically true at its position forever, giving the model an
   explicit timeline boundary between "content visible" and "content
   stubbed". Role alternation via the proven user+ack pair. Multiple sweeps
   leave a trail of markers.

7. **Index-based candidate ids (incident fix follow-up, 2026-09-20 — design
   note only, not yet implemented):** the live-sweep incident (`librarian
   reply names unknown id toolu_01Efn…`, fixed in 1.0.3 by dropping unknown
   ids instead of throwing) traces to the librarian transcribing raw
   `tool_use_id` strings — with ~70 candidates it copies ~70 long random ids,
   and one mistyped character produces an "unknown" (the garbled copy) paired
   with a "missing" (its intended twin, now unanswered). Rather than only
   tolerating that class, eliminate it at the source: `buildSweepPrompt`
   numbers candidates `1..N` in the prompt instead of printing their
   `tool_use_id`, and `parseSweepReply` parses the small integer the reply
   names and maps it back to the corresponding `toolUseId` positionally (by
   index into the same candidates array the prompt was built from). Small
   integers are far cheaper for the model to reproduce exactly than long
   random ids, so both the omission-typo and the unknown-typo classes shrink
   at the root instead of being caught and defaulted after the fact.
8. **Running tool-result tally as the trigger's first tier (Dan, 2026-09-20
   20:23 — design note, not yet implemented):** only tool results fold, so
   the trigger does not need to rescan the whole transcript every turn.
   The existing `tool.call` observer middleware (main thread only) measures
   each result's estimated tokens as it is born and accumulates a
   since-last-sweep tally in the store (candidate-eligible results only,
   >= 256 tokens; subagent calls excluded). `turn.complete` then compares
   the tally — O(1) forever, however long the session — and runs today's
   full scan only as CONFIRMATION when the tally suggests the threshold is
   crossed, with a small backoff so a high tally whose results have not yet
   aged past foldAgeTurns does not re-trigger the confirmation scan every
   turn. A successful sweep resets the tally. Beyond cost: counting events
   at birth is VIEW-INDEPENDENT — it decouples the trigger from
   `$.session.messages()` raw-vs-live semantics (the F2 family's root), and
   in the delta-sweep world the tally IS the quantity that matters
   ("unjudged mass since the last sweep") rather than an approximation of
   it. Composes with keep-memory (item in the 1.0.4 perf pass): tally as
   cheap pre-gate, keep-aware scan as the exact check.
   HARD-GATE refinement (Dan, 2026-09-20 21:08): the strongest form is not a
   threshold compare but a zero-gate — if ZERO candidate-eligible tool
   results (>=256 tokens, non-subagent) were observed since the last sweep,
   `turn.complete` returns immediately without scanning the transcript or
   calling shouldSweep at all. Most turns in a conversation-heavy phase have
   no new foldable tool output, so this makes them genuinely free (no scan,
   no librarian). Note the SCOPE limit this session made vivid: it stops
   origami's OWN wasted scans, but a talk-heavy session still grows via
   conversation (which v1 cannot fold) until the ENGINE's stock
   auto-compaction fires — that latency is the engine's, not origami's, and
   only chapter folds (v2) removes it. The counter is the right efficiency
   fix; chapter folds is the completeness fix.
11. **Consecutive-refusal backoff (2026-09-20 21:04, from the live
    security-dense session):** even 1.0.5's graceful batch-refusal
    (allSettled → defaulted → skip) costs the librarian round-trip. On a
    session whose content trips the safety classifier on every batch
    (F14), sweeps keep re-paying that round-trip and folding nothing. After
    N consecutive sweeps that fold nothing (all-defaulted / all-refused),
    origami should back off exponentially (widen the effective cooldown)
    rather than retry every trigger, so an unfoldable session stops
    bleeding time. The librarian framing preamble (item 9) is the fix that
    makes such sessions foldable in the first place; this backoff is the
    cheap insurance for when it still refuses.
9. **Librarian framing preamble (smoke finding F14, 2026-09-20 — design
   note, not yet implemented):** compaction decontextualizes. The librarian
   re-submits the extracted candidate content to haiku as a bare
   summarization prompt, stripped of the conversational arc that made
   security-adjacent material benign — which live-tripped Fable's dual-use
   safety gating on a long security-heavy session (F14). `buildSweepPrompt`
   should open with a framing preamble establishing the legitimate frame the
   extraction removed: the librarian is summarizing tool output from an
   authorized development/context-management task, not generating or acting
   on the content. This restores context, not suppresses a signal — it does
   not weaken any real safety property. Pairs with the existing fallback
   matrix, which already treats a `$.model.complete` classifier refusal as
   an ordinary librarian failure (skip + cooldown), so the preamble reduces
   spurious refusals rather than being load-bearing for correctness.

## v2+ sketch: Marian, the decision genealogist (Dan, 2026-09-19 22:01)

With a permanent transcript (cleanupPeriodDays now archival) and chapter
folds, origami gains the substrate for a decision genealogy: Marian — the
librarian writes the stubs, Marian keeps the card catalog of WHY.

- **Extraction at fold time, by the reader who sees everything.** The
  librarian invariant already pays for a full read of whatever folds; Marian
  is a second output of that same read: decision events emitted alongside
  the stub — decided X, because Y, supersedes Z — each anchored to VERBATIM
  transcript coordinates (session id + row), never to paraphrase. Chapter
  folds are the natural unit: cataloging a chapter's decisions is part of
  folding it.
- **Query side:** a lineage tool (hydrate's sibling): ask about a decision,
  get its ancestry chain — made / amended / superseded / revived — with
  hydrate:// links into the folds where each link was forged. Answers carry
  receipts, not recollections.
- **What it fixes:** supersession is exactly what summaries lose ("summaries
  preserve PLANS better than their RETIREMENTS"); Marian's records cannot
  launder through a summary boundary (they cite the verbatim tier), and a
  model can settle "did I decide this or inherit it from a summary?" against
  the record — closing the Dory effect's last gap.
- **Relation to memory-rlm:** memory_decisions indexes after the fact from
  outside; Marian extracts at fold time from inside, into the same store the
  projection layer already trusts. This is the supersession path.

Open questions for the v2 implementation:
- Chapter sizing (fixed turn count vs. librarian-chosen topical boundaries).
- Whether chapter stubs occupy a user or assistant slot (role alternation).
- Interaction with the engine's own precompute-compaction trigger.
- Whether pinned tool-folds inside a folded chapter fold with it or stay out.
