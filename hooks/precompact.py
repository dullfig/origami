#!/usr/bin/env python3
"""PreCompact hook for context folding.

Fires when auto-compact triggers (or manual /compact).  Three jobs:
  1. Parse the transcript into logical sections and save as folds
  2. Run the Haiku librarian for relevance scoring
  3. Return custom compact instructions so Opus writes fold-aware summaries

Input (stdin JSON):
  { "transcript_path": "...", ... }

Output (stdout, exit 0):
  Custom compaction instructions text
"""

import json
import os
import sys

# Resolve plugin root so core/ imports work regardless of cwd
_PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PLUGIN_ROOT)

from core.fold_store import FoldStore
from core.token_counter import estimate_tokens
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
        sys.exit(1)  # nothing to do

    with open(transcript_path, "r", encoding="utf-8") as f:
        transcript_content = f.read()

    if not transcript_content.strip():
        sys.exit(1)

    # ── Parse transcript into sections ────────────────────────────────
    store = FoldStore()
    state = store.load_state()

    sections = parse_transcript(transcript_content)
    if not sections:
        sys.exit(1)

    # Skip sections we already folded (match on turn_range)
    existing_ranges = {tuple(f["turn_range"]) for f in state["folds"]}

    new_fold_ids = []
    for section in sections:
        tr = tuple(section["turn_range"])
        if tr in existing_ranges:
            continue

        fold_id = store.next_fold_id(state)
        # Placeholder summary (Opus will refine via write_summary later)
        placeholder = section["content"][:200].replace("\n", " ").strip()

        store.add_fold(
            state,
            fold_id,
            summary=placeholder,
            detail_content=section["content"],
            turn_range=list(section["turn_range"]),
            files_touched=section.get("files_touched", []),
        )
        new_fold_ids.append(fold_id)

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

    # ── Return custom compact instructions ────────────────────────────
    fold_index = _build_fold_index(state)
    new_ids_str = ", ".join(new_fold_ids) if new_fold_ids else "(none)"

    instructions = f"""\
CONTEXT FOLDING ACTIVE - {len(state['folds'])} sections tracked

{fold_index}

New folds this compaction: {new_ids_str}

COMPACTION INSTRUCTIONS - follow these while summarising:

1. For EACH conversation section, write a SELF-COMPRESSED SUMMARY.
   - You are the only reader - maximise information density.
   - Use abbreviations: >refac, >impl, >fix, >add, >mod, >del
   - Compress paths: auth.middleware.ts -> auth.mid.ts
   - Note cross-references: "builds on F003"
   - Format: topic>action: key.details | outcome | D:files

2. Reference fold IDs (F001, F002...) so future-you can unfold on demand.

3. Keep the fold index visible in the compacted context so you always
   know what sections exist and can call unfold_section when needed.
"""

    sys.stdout.write(instructions)
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


def _build_fold_index(state):
    total_detail = sum(f.get("detail_tokens", 0) for f in state["folds"])
    lines = [
        f"[FOLD INDEX - {len(state['folds'])} sections, "
        f"{state['total_summary_tokens']} summary tok, "
        f"{total_detail} detail tok stored]",
        "",
    ]
    for fold in state["folds"]:
        fid = fold["id"].upper().replace("FOLD-", "F")
        status = fold["status"].upper()
        rel = fold.get("relevance_score", 0)
        lines.append(
            f"[{fid} | {status} | {fold['detail_tokens']} tok | rel:{rel:.2f}]"
        )
        lines.append(f"  {fold['summary'][:150]}")
        lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    main()
