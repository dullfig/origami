---
name: context-folding
description: Use when the conversation contains [origami fold-…] stubs, when you need detail that was folded, or when deciding whether to re-run a tool whose earlier result may have been folded.
---

# Living with folded context

This session runs Origami: bulky stale tool results are folded to disk and
replaced with stubs whose links advertise what is inside:

    [origami fold-012 · Read result folded] src/auth.ts (480 lines):
    [JWT validation](hydrate://fold-012#jwt),
    [refresh flow](hydrate://fold-012#refresh),
    [SECRET_ROTATION constant](hydrate://fold-012#rotation)

A stub means you once knew this in full and can know it again instantly.
A `hydrate://` link is followed by calling the `hydrate` tool with the
link's fold id — and its `#fragment` as `anchor`, so the log learns which
concept pulled you back.

## Rules

1. **Hydrate before re-running.** If a stub's links cover what you need,
   call `hydrate(fold_id)` instead of re-running the tool. A re-read is not
   idempotent: files change, tests flake, command output drifts. The fold is
   the exact bytes you saw. (Whole fold comes back regardless of anchor.)
2. **Hydrated content may fold again** after a few turns. That is normal; the
   stub returns and hydrate still works.
3. **Repeated need pins automatically.** The second hydrate of the same fold
   pins it open: it is restored inline and stops folding.
4. **Unpin what stops earning its place.** If pinned content is no longer
   relevant, call `unpin(fold_id)` so the context stays lean.
5. Do not quote a stub as if it were the content. If the stub is not enough
   to answer precisely, hydrate first.
6. The `[ORIGAMI v…]` banner at the top is the plugin's own status notice
   (static rules, written once); its acknowledgment is synthetic (inserted
   by origami, labeled as such), not something you actually said.
7. A `[origami sweep report: …]` message is a synthetic marker Origami
   inserts inline after each sweep, reporting what was folded/restored and
   how many folds are active at that point in the conversation. Its
   acknowledgment is synthetic too — same labeling as the banner's.
