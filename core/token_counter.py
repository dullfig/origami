"""Token estimation using character-based heuristic.

~4 characters per token for English text, ~3.5 for code.
Uses 3.75 as a middle ground.
"""


def estimate_tokens(text):
    """Estimate token count from text length."""
    if not text:
        return 0
    return max(1, int(len(text) / 3.75))
