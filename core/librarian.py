"""Haiku-based relevance scoring for fold sections.

Calls Claude Haiku to evaluate how relevant each fold is to the current
task context.  Returns a dict of fold_id -> score (0.0-1.0).

Falls back to a flat default score if the API key is missing or the
call fails, so the rest of the system keeps working.
"""

import json
import os
import sys


DEFAULT_SCORE = 0.3


def score_relevance(fold_summaries, current_context, api_key=None):
    """Score each fold's relevance to the current context.

    Args:
        fold_summaries: list of {"id": str, "summary": str}
        current_context: the most recent user message / task description
        api_key: Anthropic API key (falls back to ANTHROPIC_API_KEY env var)

    Returns:
        dict mapping fold_id to a float score in [0.0, 1.0]
    """
    api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return {f["id"]: DEFAULT_SCORE for f in fold_summaries}

    if not fold_summaries:
        return {}

    try:
        from anthropic import Anthropic

        client = Anthropic(api_key=api_key)

        summaries_text = "\n".join(
            f"- {f['id']}: {f['summary']}" for f in fold_summaries
        )

        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=256,
            messages=[
                {
                    "role": "user",
                    "content": (
                        "Rate the relevance (0.0-1.0) of each conversation "
                        "section to the current task.  Higher = more likely "
                        "needed.\n\n"
                        f"Current task/context:\n{current_context}\n\n"
                        f"Sections:\n{summaries_text}\n\n"
                        "Return ONLY a JSON object mapping section IDs to "
                        'scores, e.g. {"fold-001": 0.8, "fold-002": 0.2}'
                    ),
                }
            ],
        )

        text = response.content[0].text.strip()

        # Extract JSON even if Haiku wraps it in prose
        start = text.index("{")
        end = text.rindex("}") + 1
        scores = json.loads(text[start:end])

        return {
            fold_id: max(0.0, min(1.0, float(score)))
            for fold_id, score in scores.items()
        }

    except Exception as exc:
        print(f"[context-folding] librarian error: {exc}", file=sys.stderr)
        return {f["id"]: DEFAULT_SCORE for f in fold_summaries}
