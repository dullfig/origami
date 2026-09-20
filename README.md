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
turn ends ──► turn.complete: stale unpinned tool-result mass ≥ minFoldMass,
                        │            and grown ≥ 20% past the last skip?
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
              Rebuilder → { messages }   (verbatim text + stubs, pairs intact)
                        │  any failure anywhere → next(event) or {skip}
                        ▼
              Store: bodies → $.fs, index → $.store
                        │  ONLY once the reduction gate has passed — a skipped
                        │  sweep persists nothing and records its skip mass
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
| `minReductionRatio` | 0.15 | Below this, a sweep is skipped (and the trigger goes quiet until the candidate mass grows 20% past what it skipped on, so a skip cannot livelock into a librarian call every turn) |
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
│   ├── fold-001.md      # a small header, a delimiter, then the exact bytes
│   ├── fold-002.md
│   └── ...
└── origami.log           # append-only JSONL: sweep, hydrate, and unpin records
```

A fold body file is `# <id> · <tool> <input>`, the delimiter line
`<<<origami:body>>>`, and then the original tool result **verbatim**. The
header lives on the far side of the delimiter so a restore puts back the
exact bytes and an unpin → refold cycle cannot nest a second header.

The fold index itself (id, stub, state, origin turn, size estimate,
hydration count) lives in `$.store`, not on disk as a separate file. Both
`$.fs` and `$.store` persist across `--resume` and process restarts.

`$.store` is **plugin-global** — one JSON file under the user's Claude Code
configuration directory, shared by every project this plugin runs in —
while `$.fs` relative paths resolve under the session's working directory.
Origami therefore prefixes every store key with `origami@<hash>/`, where the
hash is a short FNV-1a of `await $.session.root()`, so one project's fold
index, sequence counter and flags never reach another's.

A fold entry is `folded`, `pinned` or `evicted`. Each sweep reconciles the
index against reality: a `folded` entry whose stub no longer appears
anywhere in the transcript becomes `evicted` — it stops counting toward the
banner, stops matching the missed-hydrate observer, and is never restored.
Its body stays on disk, so `hydrate` still serves it and says so.

## The status banner

On the first successful sweep, Origami prepends a synthetic message pair to
the very top of the context: a user-role message starting `[ORIGAMI v…` that
states the plugin is in beta, explains how to follow `hydrate://` links and
call `hydrate` before re-running a tool or concluding content was never
seen, and assigns a "BETA DUTY" to explicitly flag to the user anything that
looks like a stub/reality mismatch or an unlocatable reference — followed by
a synthetic assistant acknowledgment.

This banner is **static**: it carries rules only, never a fold count, and is
written once. Every later sweep leaves it untouched — the same message
objects, handles intact — as long as its text still matches the current
version's wording, which is a deliberate prompt-cache win (index 0/1 would
otherwise be rewritten, and the cache busted from token zero, on every
sweep). If the wording no longer matches (a version bump, or migrating from
an older count-carrying banner), it is rebuilt exactly once.

The mutable status lives inline instead: every successful sweep appends a
small synthetic marker pair — a user-role message starting
`[origami sweep report: folded …; restored …; N folds now active. …]` plus a
tiny assistant acknowledgment — at the tail of the rebuilt messages. Each
marker is historically true at its position in the transcript forever,
giving the model an explicit timeline boundary between "content visible"
and "content stubbed" at that point in the conversation. Multiple sweeps
leave a trail of markers.

Neither pair is part of the real conversation, and every synthetic
acknowledgment is explicitly provenance-labeled, ending
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

Observed (2026-09-19 smoke tests, Claude Code 2.1.278): classic PostCompact
hooks DO fire on origami sweeps. An automatic (mass-triggered) sweep reaches
them with trigger value **`plugin`**; a sweep initiated by `/compact` reaches
them as **`manual`**. Gate classic hooks that assume lossy compaction to
`auto` (and `manual` if you never type /compact expecting a fold sweep) —
`plugin` is always a lossless origami sweep.

**Warning — stock compaction destroys fold context.** If built-in
summarization runs over a folded conversation (e.g. `/compact` when origami
finds nothing to fold and passes through, or auto-compact at the window
limit), the summary replaces the banner and every `[origami fold-…]` stub:
fold bodies remain safe on disk, but the model loses its hydrate links.
Avoid manual `/compact` when the banner shows active folds and the context
is already lean.

Note for headless use: because `$.session.compact()` is unavailable under
`-p`, automatic mass-triggered sweeps never fire there (the trigger detects
the condition, logs, and falls through cleanly). A `/compact` prompt runs
the full fold sweep in headless sessions.

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
