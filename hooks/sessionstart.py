#!/usr/bin/env python3
"""SessionStart hook for context folding.

Runs after compaction (matcher: compact) or session resume (matcher: resume).
Injects the fold index plus any unfolded sections into the new context so
the model has a complete narrative thread at variable resolution.

Input (stdin JSON):
  { "session_id": "...", "source": "compact|resume", "model": "...", ... }

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


def main():
    # ── Read hook input ───────────────────────────────────────────────
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, Exception):
        hook_input = {}

    # Matcher in hooks.json already filters to compact/resume.
    # Just load fold state and inject.
    store = FoldStore()
    state = store.load_state()

    if not state["folds"]:
        sys.exit(1)  # nothing to inject

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
    lines = [
        f"[CONTEXT FOLDING - {len(state['folds'])} sections, "
        f"{total_stored} tokens stored]",
        "",
    ]

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

    lines.append("Call the origami_guide tool for instructions on using context folding.")

    # ── Persist any budget-forced status changes ──────────────────────
    store.save_state(state)

    sys.stdout.write("\n".join(lines))
    sys.exit(0)


if __name__ == "__main__":
    main()
