#!/usr/bin/env python3
"""PreCompact hook for context folding.

Fires when auto-compact triggers (or manual /compact).  Two jobs:
  1. Parse the transcript into logical sections and save as folds to disk
  2. Run the Haiku librarian for relevance scoring

This is a read-only hook - it cannot influence how compaction works.
Its purpose is to preserve the full transcript detail on disk BEFORE
compaction summarises it away.  The SessionStart hook (matcher: compact)
re-injects fold state after compaction finishes.

Input (stdin JSON):
  { "session_id": "...", "transcript_path": "...", "trigger": "auto|manual", ... }

Output: none (exit 0 to allow compaction to proceed)
"""

import json
import os
import sys

# Resolve plugin root so core/ imports work regardless of cwd
_PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PLUGIN_ROOT)

from core.fold_store import FoldStore
from core.transcript_parser import parse_transcript
from core.librarian import score_relevance


def main():
    # ── Read hook input ───────────────────────────────────────────────
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, Exception):
        hook_input = {}

    transcript_path = hook_input.get("transcript_path", "")
    if not transcript_path or not os.path.exists(transcript_path):
        sys.exit(0)  # nothing to do, let compaction proceed

    with open(transcript_path, "r", encoding="utf-8") as f:
        transcript_content = f.read()

    if not transcript_content.strip():
        sys.exit(0)

    # ── Parse transcript into sections ────────────────────────────────
    store = FoldStore()
    state = store.load_state()

    sections = parse_transcript(transcript_content)
    if not sections:
        sys.exit(0)

    # Skip sections we already folded (match on turn_range)
    existing_ranges = {tuple(f["turn_range"]) for f in state["folds"]}

    for section in sections:
        tr = tuple(section["turn_range"])
        if tr in existing_ranges:
            continue

        fold_id = store.next_fold_id(state)
        # Placeholder summary - model refines via write_summary MCP tool later
        placeholder = section["content"][:200].replace("\n", " ").strip()

        store.add_fold(
            state,
            fold_id,
            summary=placeholder,
            detail_content=section["content"],
            turn_range=list(section["turn_range"]),
            files_touched=section.get("files_touched", []),
        )

    # ── Extract current context for the librarian ─────────────────────
    current_context = _last_user_message(sections)

    # ── Run Haiku librarian ───────────────────────────────────────────
    if state["folds"]:
        summaries = [
            {"id": f["id"], "summary": f["summary"]}
            for f in state["folds"]
        ]
        scores = score_relevance(summaries, current_context)

        threshold = 0.7  # aggressive: only unfold highly relevant sections
        for fold in state["folds"]:
            score = scores.get(fold["id"], 0.3)
            fold["relevance_score"] = score
            fold["status"] = "unfolded" if score >= threshold else "folded"

    # ── Persist ───────────────────────────────────────────────────────
    store.save_state(state)
    sys.exit(0)


# ── helpers ────────────────────────────────────────────────────────────

def _last_user_message(sections):
    """Walk sections backwards to find the last user turn's text."""
    for section in reversed(sections):
        for turn in reversed(section.get("turns", [])):
            if turn.get("role") == "user":
                return _text_of(turn)
    return ""


def _text_of(entry):
    content = entry.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return " ".join(parts)
    return str(content)


if __name__ == "__main__":
    main()
