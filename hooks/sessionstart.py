#!/usr/bin/env python3
"""SessionStart hook for context folding.

Runs on startup, after compaction (matcher: compact), or session resume.
ALWAYS injects context folding awareness — even when no folds exist yet.
When folds are present, injects the fold index plus any unfolded sections
so the model has a complete narrative thread at variable resolution.

Input (stdin JSON):
  { "session_id": "...", "source": "compact|resume|startup", "model": "...", ... }

Output (stdout, exit 0):
  Text to inject into the conversation context
"""

import json
import os
import sys

_PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PLUGIN_ROOT)

from core.fold_store import FoldStore
from core.token_counter import estimate_tokens


# Aggressive folding: research shows LLM performance degrades well before
# context is exhausted (7-15k tokens in "Lost in the Middle" and related
# studies).  Keep injected context lean - 20% of window max, and cap the
# number of simultaneously unfolded sections to avoid the "lost in the
# middle" U-curve where mid-context information is effectively invisible.
CONTEXT_WINDOW = 200_000
BUDGET = int(CONTEXT_WINDOW * 0.20)  # 40 000 tokens
MAX_UNFOLDED = 3  # never unfold more than 3 sections at once

AWARENESS_HEADER = """\
[CONTEXT FOLDING ACTIVE — Origami]
You have a context folding system. Your conversation history is preserved at
variable resolution — each section has an always-visible summary, with full
detail stored on disk and expandable on demand.

Available MCP tools:
  unfold_section(fold_id) — expand a folded section to full detail
  fold_section(fold_id)   — collapse back to summary-only
  list_folds()            — show all sections with status and summaries
  write_summary(fold_id, summary) — update a fold's self-compressed summary
  origami_guide()         — get the full usage guide

When you see fold IDs like [F001 | FOLDED | 3200 tok], you can unfold them
to see the full conversation detail. Fold sections back when done to keep
context lean. Prefer aggressive folding — smaller context = better reasoning.
"""


def main():
    # ── Read hook input ───────────────────────────────────────────────
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, Exception):
        hook_input = {}

    store = FoldStore()
    state = store.load_state()

    lines = [AWARENESS_HEADER]

    if not state["folds"]:
        # No folds yet — inject awareness only
        lines.append("No folds stored yet. Folds will appear after your first compaction.")
        lines.append("")
        sys.stdout.write("\n".join(lines))
        sys.exit(0)

    # ── Token budget management ───────────────────────────────────────
    # Summaries always included
    used = sum(f.get("summary_tokens", 0) for f in state["folds"])
    remaining = BUDGET - used

    # Greedily unfold by relevance score within budget
    by_relevance = sorted(
        state["folds"],
        key=lambda f: f.get("relevance_score", 0),
        reverse=True,
    )

    unfold_ids = set()
    for fold in by_relevance:
        if fold["status"] == "unfolded":
            dtok = fold.get("detail_tokens", 0)
            if dtok <= remaining and len(unfold_ids) < MAX_UNFOLDED:
                unfold_ids.add(fold["id"])
                remaining -= dtok
            else:
                fold["status"] = "folded"  # over budget or cap hit

    # ── Build context injection ───────────────────────────────────────
    total_stored = sum(f.get("detail_tokens", 0) for f in state["folds"])
    lines.append(
        f"[{len(state['folds'])} sections, {total_stored} tokens stored]"
    )
    lines.append("")

    for fold in state["folds"]:
        fid = fold["id"].upper().replace("FOLD-", "F")
        status = fold["status"].upper()
        dtok = fold.get("detail_tokens", 0)
        rel = fold.get("relevance_score", 0)

        lines.append(f"[{fid} | {status} | {dtok} tok | rel:{rel:.2f}]")
        lines.append(fold.get("summary", ""))

        if fold["id"] in unfold_ids:
            detail = store.read_fold_detail(fold["id"])
            if detail:
                lines.append("")
                lines.append("--- FULL DETAIL ---")
                lines.append(detail)
                lines.append("--- END DETAIL ---")

        lines.append("")

    # ── Persist any budget-forced status changes ──────────────────────
    store.save_state(state)

    sys.stdout.write("\n".join(lines))
    sys.exit(0)


if __name__ == "__main__":
    main()
