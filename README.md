# Origami

Context folding for Claude Code. Origami keeps the live context lean
*continuously*: bulky, stale tool results are folded to disk behind an
always-visible stub written by a librarian that saw the full content before
it folded, and the exact bytes come back on demand via a `hydrate` tool.
Conversation text — everything the user and the model actually said — is
never rewritten or summarized; only tool output is folded, and every fold is
reversible. Origami rides Claude Code's own compaction machinery (function
hooks / "Claude Mods"), so it triggers on token *mass*, not on window-fill
percentage — behavior is identical whether the window is 200k or 1M tokens.

## How It Works

```
turn ends ──► turn.complete: stale unpinned tool-result mass ≥ minFoldMass?
                        │ no → nothing (window fill is irrelevant)
                        │ yes
                        ▼
              $.session.compact()      (manual /compact and auto-compact
                        │               arrive at the same interceptor)
                        ▼
              session.compact hook
                        │  candidates = unpinned results older than foldAgeTurns
                        ▼
              Librarian (Haiku, full content visible)
                        │  keep / fold + stub per candidate
                        ▼
              Store: bodies → $.fs, index → $.store
                        ▼
              Rebuilder → { messages }   (verbatim text + stubs, pairs intact)
                        │  any failure anywhere → next(event) or {skip}
                        ▼
              conversation continues ──► model calls hydrate(fold-012)
                                              │  full content at tail; count++;
                                              ▼  logged; 2nd hydrate → pinned
                                        eligible to refold on a later sweep
```

Because candidates age in at `foldAgeTurns`, accumulating mass sits near the
tail; each sweep's cache invalidation extends only from the oldest new fold
forward. There is no separate cadence — folding emerges entirely from the
mass trigger.

A folded result looks like this in the transcript:

```
[origami fold-012 · Read result folded] src/auth.ts (480 lines):
[JWT validation](hydrate://fold-012#jwt),
[refresh flow](hydrate://fold-012#refresh),
[SECRET_ROTATION constant](hydrate://fold-012#rotation)
```

The librarian writes the stub as anchor text — 2–4 concept-level
`[concept](hydrate://fold-NNN#slug)` links — while it can still see the
content, not as a generic note written after the fact. `hydrate` always
returns the whole fold regardless of which link (or none) motivated the
call; the `#slug` fragment is logged as the `anchor` that pulled the model
back, reserved for future range-hydration and prefetch work.

If a sweep's estimated reduction is too small to be worth the cache-cost, or
anything in the pipeline fails (model error, storage error, malformed
librarian output), Origami falls back to Claude Code's own built-in
compaction — the session is never left worse off than stock behavior.

## Installation

Prerequisites: Claude Code >= 2.1.259, run with function hooks enabled:

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

<!-- TODO(smoke): verify marketplace syntax -->
```bash
claude plugin marketplace add dullfig/origami
claude plugin install origami@origami
```

Nothing else is required: no Node/Python dependencies, no API key, no
separate server process — the whole plugin is one TypeScript function-hooks
module.

## Configuration

Set via `.claude-plugin/plugin.json`'s `userConfig` (or your Claude Code
plugin configuration UI):

| Option | Default | Meaning |
| --- | ---: | --- |
| `foldAgeTurns` | 3 | Results younger than this are never candidates |
| `minFoldMass` | 20000 | Candidate token mass that triggers a sweep |
| `workingSetBudget` | 100000 | Absolute live-context tokens; above it, sweeps turn aggressive |
| `preserveRecentTurns` | 3 | Turns the rebuilder never touches |
| `minReductionRatio` | 0.15 | Below this, a sweep is skipped |
| `pinAfterHydrations` | 2 | Hysteresis threshold |
| `librarianModel` | `haiku` | Passed to `$.model.complete` |

Token counts are estimated without a tokenizer (chars/4 heuristic,
calibrated against `$.session.usage()`'s breakdown when available).

When live context exceeds `workingSetBudget`, the next sweep runs
aggressive: `foldAgeTurns` and `preserveRecentTurns` both relax to 1 (only
the current turn stays protected), and the librarian is told the working set
is over budget so it folds everything not clearly needed.

## Tools

| Tool | Description |
|------|-------------|
| `hydrate(fold_id, anchor?)` | Expands a fold to its full stored content. Call it before re-running a tool whose result was folded — a re-run may not reproduce it (files change, tests flake, output drifts). `fold_id` appears in `[origami fold-…]` stubs and in `hydrate://` links; pass a link's `#fragment` as `anchor` when a specific link motivated the call. The second hydrate of a given fold pins it: the next sweep restores it inline and it stays open until unpinned. |
| `unpin(fold_id)` | Releases a pinned fold so it becomes fold-eligible again. Use it when pinned content stops earning its place in context — the recovery path for a pin that hysteresis triggered prematurely. |

Registered tool names are `mcp__origami__hydrate` and `mcp__origami__unpin`;
the model sees and calls them by these names.

Every `hydrate` and `unpin` call is appended to the event log (see Data
storage) — the future training set for anticipatory prefetch.

Implementation note for contributors: a `tool.call` hook serving one of
these registered tools must answer with `{ result }`, not `{ text }` — the
latter is set by core from the former and is absent on a hook's own answer.
Verified against `types/claude-code.d.ts`'s `ToolCallResult` declarations.

## Data storage

All Origami state lives under `.claude/origami/` in the project:

```
.claude/origami/
├── folds/
│   ├── fold-001.md      # exact folded content, plus a small header
│   ├── fold-002.md
│   └── ...
└── origami.log           # append-only JSONL: sweep, hydrate, and unpin records
```

The fold index itself (id, stub, state, origin turn, size estimate,
hydration count) lives in `$.store`, not on disk as a separate file. Both
`$.fs` and `$.store` persist across `--resume` and process restarts.

## The status banner

On every successful sweep, Origami prepends a synthetic message pair to the
very top of the context: a user-role message starting `[ORIGAMI v…` that
states the plugin is in beta, explains how to follow `hydrate://` links and
call `hydrate` before re-running a tool or concluding content was never
seen, assigns a "BETA DUTY" to explicitly flag to the user anything that
looks like a stub/reality mismatch or an unlocatable reference, and reports
the current count of active folds — followed by a synthetic assistant
acknowledgment.

This pair is not part of the real conversation: it is rebuilt from scratch
on every sweep (the previous banner is stripped before a fresh one is
applied), and the acknowledgment is explicitly provenance-labeled, ending
`[synthetic acknowledgment inserted by origami]`, so it is never mistaken
for something the model actually said.

## Coexistence with classic hooks

Origami sweeps ride the same compaction machinery as Claude Code's built-in
compaction, so any classic **PostCompact** hooks you have configured will
fire after every Origami sweep, not just after a stock lossy compaction.
This matters because classic PostCompact hooks are typically written for
*lossy* compaction — e.g., a re-grounding banner telling the model to
re-read memory after a summary — advice that is noise after an Origami
sweep, which keeps conversation text verbatim and keeps folded content
fully recoverable via `hydrate`.

A `$.session.compact()`-triggered sweep reports a distinct trigger value to
classic hooks (expected: `plugin`, distinct from `manual`/`auto`). If your
classic PostCompact hooks assume lossy compaction, gate them to the
`manual`/`auto` matchers so they fire only on stock compaction — the only
kind that still deserves them.

<!-- TODO(smoke): replace with observed trigger value from Task 10 -->

## Early-access caveat

Function hooks ("Claude Mods") are early access; the `$` API surface may
change between Claude Code releases without notice. `types/claude-code.d.ts`
is a pinned, generated snapshot of that surface — this copy was generated by
`/plugin-types` under **Claude Code 2.1.278** (recorded in the file's first
line). Do not assume compatibility with other versions.

After upgrading Claude Code, regenerate the types before trusting the
surface again. Interactively:

```
/plugin-types
```

Non-interactively (verified to work from a shell):

```bash
MSYS_NO_PATHCONV=1 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p "/plugin-types"
```

The output lands in `.claude/types/`; copy the generated file over
`types/claude-code.d.ts`.

## License

MIT
