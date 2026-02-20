"""Parse Claude Code transcript into logical sections for folding.

Reads JSONL transcript format (one JSON object per line) and groups
turns into sections based on topic boundaries.
"""

import json
import re


def parse_transcript(transcript_content):
    """Parse a Claude Code transcript into logical sections.

    Returns list of sections, each with:
      - turns: list of raw turn dicts
      - turn_range: [start_turn, end_turn]
      - files_touched: list of file paths referenced
      - content: concatenated text content
    """
    entries = _read_entries(transcript_content)
    if not entries:
        return []

    sections = []
    current = _new_section(start_turn=1)
    turn_number = 0
    assistant_turns_since_user = 0

    for entry in entries:
        role = entry.get("role", "")

        if role == "user":
            turn_number += 1
            # Start a new section if the current one has enough substance
            if len(current["turns"]) >= 3 and assistant_turns_since_user >= 2:
                sections.append(_finalize(current, turn_number - 1))
                current = _new_section(start_turn=turn_number)
            assistant_turns_since_user = 0
        elif role == "assistant":
            assistant_turns_since_user += 1
            turn_number += 1

        current["turns"].append(entry)

        text = _extract_content(entry)
        if text:
            current["content_parts"].append(text)

        files = _extract_files(entry)
        current["files_touched"].update(files)

    # Finalize the last section
    if current["turns"]:
        sections.append(_finalize(current, max(turn_number, 1)))

    return sections


def parse_transcript_file(path):
    """Convenience: read a transcript file and parse it."""
    with open(path, "r", encoding="utf-8") as f:
        return parse_transcript(f.read())


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _new_section(start_turn):
    return {
        "turns": [],
        "files_touched": set(),
        "content_parts": [],
        "start_turn": start_turn,
    }


def _finalize(section, end_turn):
    return {
        "turns": section["turns"],
        "turn_range": [section["start_turn"], end_turn],
        "files_touched": sorted(section["files_touched"]),
        "content": "\n".join(section["content_parts"]),
    }


def _read_entries(text):
    """Try JSONL first, fall back to single JSON array."""
    entries = []
    for line in text.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            # Could be a single message or a wrapper with a message inside
            if isinstance(obj, dict):
                if "role" in obj:
                    entries.append(obj)
                elif "message" in obj and isinstance(obj["message"], dict):
                    entries.append(obj["message"])
        except json.JSONDecodeError:
            continue

    if entries:
        return entries

    # Maybe the whole thing is a JSON array
    try:
        arr = json.loads(text)
        if isinstance(arr, list):
            return [e for e in arr if isinstance(e, dict) and "role" in e]
    except json.JSONDecodeError:
        pass

    return []


def _extract_content(entry):
    """Pull readable text from a transcript entry."""
    content = entry.get("content", "")

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                btype = block.get("type", "")
                if btype == "text":
                    parts.append(block.get("text", ""))
                elif btype == "tool_use":
                    name = block.get("name", "unknown")
                    inp = json.dumps(block.get("input", {}))
                    # Truncate very long tool inputs
                    if len(inp) > 500:
                        inp = inp[:500] + "..."
                    parts.append(f"[Tool: {name}] {inp}")
                elif btype == "tool_result":
                    result_content = block.get("content", "")
                    if isinstance(result_content, str):
                        parts.append(result_content[:500])
                    elif isinstance(result_content, list):
                        for rb in result_content:
                            if isinstance(rb, dict) and rb.get("type") == "text":
                                parts.append(rb.get("text", "")[:500])
        return "\n".join(parts)

    return str(content) if content else ""


def _extract_files(entry):
    """Heuristic extraction of file paths from a transcript entry."""
    files = set()
    content = entry.get("content", "")

    if isinstance(content, list):
        content = json.dumps(content)
    elif not isinstance(content, str):
        content = str(content)

    # Match tool call file_path arguments
    for match in re.finditer(r'"file_path"\s*:\s*"([^"]+)"', content):
        files.add(match.group(1))

    # Match path arguments
    for match in re.finditer(r'"path"\s*:\s*"([^"]+\.\w+)"', content):
        files.add(match.group(1))

    return files
