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

Open questions for the v2 implementation:
- Chapter sizing (fixed turn count vs. librarian-chosen topical boundaries).
- Whether chapter stubs occupy a user or assistant slot (role alternation).
- Interaction with the engine's own precompute-compaction trigger.
- Whether pinned tool-folds inside a folded chapter fold with it or stay out.
