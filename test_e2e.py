#!/usr/bin/env python3
"""End-to-end test for Origami context folding.

Simulates the full lifecycle:
  1. Multi-topic conversation transcript
  2. PreCompact hook: parse, fold, score
  3. Verify fold state on disk
  4. SessionStart hook: inject folded context
  5. MCP server: origami_guide, list_folds, unfold, write_summary, fold
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

PLUGIN_ROOT = os.path.dirname(os.path.abspath(__file__))
FOLD_DIR = os.path.join(PLUGIN_ROOT, ".claude", "context-folding")
PYTHON = sys.executable
NODE = "node"

# Try to find node
for candidate in [
    "node",
    r"C:\Program Files\nodejs\node.exe",
    "/c/Program Files/nodejs/node.exe",
]:
    try:
        subprocess.run([candidate, "--version"], capture_output=True, timeout=5)
        NODE = candidate
        break
    except Exception:
        continue

PASS = 0
FAIL = 0


def check(label, condition, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  PASS  {label}")
    else:
        FAIL += 1
        print(f"  FAIL  {label}")
        if detail:
            print(f"        {detail}")


def cleanup():
    if os.path.exists(FOLD_DIR):
        shutil.rmtree(FOLD_DIR)


def build_transcript():
    """Build a realistic multi-topic conversation transcript."""
    turns = [
        # Topic 1: Auth middleware bug (turns 1-5)
        {"role": "user", "content": "There's a bug in auth.middleware.ts - JWT tokens aren't being validated properly"},
        {"role": "assistant", "content": "Let me look at the auth middleware."},
        {"role": "assistant", "content": [
            {"type": "tool_use", "name": "Read", "input": {"file_path": "src/auth.middleware.ts"}},
        ]},
        {"role": "assistant", "content": "Found the issue - you're using jwt.decode() which doesn't verify the signature. Changing to jwt.verify()."},
        {"role": "assistant", "content": [
            {"type": "tool_use", "name": "Edit", "input": {"file_path": "src/auth.middleware.ts", "old_string": "jwt.decode(token)", "new_string": "jwt.verify(token, SECRET)"}},
        ]},

        # Topic 2: API endpoint (turns 6-10)
        {"role": "user", "content": "Now let's add a new /api/users/profile endpoint"},
        {"role": "assistant", "content": "I'll create the profile endpoint in the users router."},
        {"role": "assistant", "content": [
            {"type": "tool_use", "name": "Read", "input": {"file_path": "src/routes/users.ts"}},
        ]},
        {"role": "assistant", "content": "Added GET /api/users/profile with auth middleware and response shaping."},
        {"role": "assistant", "content": [
            {"type": "tool_use", "name": "Write", "input": {"file_path": "src/routes/users.ts"}},
        ]},

        # Topic 3: Database migration (turns 11-15)
        {"role": "user", "content": "We need to add a 'preferences' JSONB column to the users table"},
        {"role": "assistant", "content": "I'll create a migration for that."},
        {"role": "assistant", "content": [
            {"type": "tool_use", "name": "Read", "input": {"file_path": "migrations/001_initial.sql"}},
        ]},
        {"role": "assistant", "content": "Created migration 002_add_preferences.sql with ALTER TABLE users ADD COLUMN preferences JSONB DEFAULT '{}'."},
        {"role": "assistant", "content": [
            {"type": "tool_use", "name": "Write", "input": {"file_path": "migrations/002_add_preferences.sql"}},
        ]},

        # Topic 4: Test suite (turns 16-19)
        {"role": "user", "content": "Write tests for the profile endpoint we just created"},
        {"role": "assistant", "content": "Writing integration tests for GET /api/users/profile."},
        {"role": "assistant", "content": "Added 4 test cases: valid token, expired token, missing token, malformed token. All passing."},
        {"role": "assistant", "content": [
            {"type": "tool_use", "name": "Write", "input": {"file_path": "tests/profile.test.ts"}},
        ]},
    ]
    return "\n".join(json.dumps(t) for t in turns)


def run_hook(script, stdin_data):
    """Run a Python hook script with JSON on stdin."""
    result = subprocess.run(
        [PYTHON, os.path.join(PLUGIN_ROOT, "hooks", script)],
        input=stdin_data,
        capture_output=True,
        text=True,
        cwd=PLUGIN_ROOT,
    )
    return result


def mcp_frame(msg):
    """Frame a JSON-RPC message with Content-Length header per MCP stdio spec.

    Returns bytes to avoid text-mode \\r\\n mangling on Windows.
    """
    json_bytes = json.dumps(msg).encode("utf-8")
    header = f"Content-Length: {len(json_bytes)}\r\n\r\n".encode("ascii")
    return header + json_bytes


def parse_mcp_responses(raw_output):
    """Parse Content-Length framed MCP responses from raw bytes."""
    responses = []
    buf = raw_output
    while buf:
        header_end = buf.find(b"\r\n\r\n")
        if header_end == -1:
            break
        header = buf[:header_end].decode("ascii", errors="replace")
        match = re.search(r"Content-Length:\s*(\d+)", header, re.IGNORECASE)
        if not match:
            buf = buf[header_end + 4:]
            continue
        length = int(match.group(1))
        body_start = header_end + 4
        if len(buf) < body_start + length:
            break
        body = buf[body_start:body_start + length]
        buf = buf[body_start + length:]
        try:
            responses.append(json.loads(body))
        except json.JSONDecodeError:
            continue
    return responses


def mcp_call(method, params=None, req_id=1):
    """Send a JSON-RPC request to the MCP server and return the response.

    Uses binary mode to avoid Windows text-mode \\r\\n translation that
    mangles the Content-Length framing.
    """
    stdin_data = b"".join([
        mcp_frame({
            "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1.0.0"},
            },
        }),
        mcp_frame({
            "jsonrpc": "2.0", "id": req_id, "method": method,
            "params": params or {},
        }),
    ])

    result = subprocess.run(
        [NODE, os.path.join(PLUGIN_ROOT, "server", "index.js")],
        input=stdin_data,
        capture_output=True,
        cwd=PLUGIN_ROOT,
        timeout=10,
    )

    responses = parse_mcp_responses(result.stdout)
    for resp in responses:
        if isinstance(resp, dict) and resp.get("id") == req_id:
            return resp
    return None


def main():
    print("=" * 60)
    print("ORIGAMI END-TO-END TEST")
    print("=" * 60)

    # ── Setup ─────────────────────────────────────────────────────
    cleanup()
    transcript = build_transcript()

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".jsonl", delete=False, dir=PLUGIN_ROOT
    ) as f:
        f.write(transcript)
        transcript_path = os.path.abspath(f.name)

    try:
        # ── Phase 1: PreCompact Hook ──────────────────────────────
        print("\n--- Phase 1: PreCompact Hook ---")
        hook_input = json.dumps({"transcript_path": transcript_path})
        result = run_hook("precompact.py", hook_input)

        check("precompact exits 0", result.returncode == 0,
              f"exit={result.returncode}, stderr={result.stderr[:200]}")
        check("precompact is silent (read-only hook)", len(result.stdout) == 0,
              f"stdout should be empty, got {len(result.stdout)} chars")

        # ── Phase 2: Verify Fold State ────────────────────────────
        print("\n--- Phase 2: Verify Fold State ---")
        state_path = os.path.join(FOLD_DIR, "state.json")
        check("state.json exists", os.path.exists(state_path))

        with open(state_path) as f:
            state = json.load(f)

        num_folds = len(state["folds"])
        check(f"created folds (got {num_folds})", num_folds >= 3,
              f"expected >=3 sections from 4-topic transcript")
        check("version is 1", state["version"] == 1)
        check("total_summary_tokens > 0", state["total_summary_tokens"] > 0)

        # Check individual folds
        for fold in state["folds"]:
            fid = fold["id"]
            check(f"{fid} has summary", len(fold["summary"]) > 0)
            check(f"{fid} has detail_tokens", fold["detail_tokens"] > 0)
            check(f"{fid} has timestamp", len(fold.get("timestamp", "")) > 0)

            detail_path = os.path.join(FOLD_DIR, fold["detail_file"])
            check(f"{fid} detail file exists", os.path.exists(detail_path))

        # Check relevance scores (without API key, should be 0.3 default)
        scores = [f["relevance_score"] for f in state["folds"]]
        check("relevance scores assigned",
              all(s >= 0 for s in scores),
              f"scores={scores}")

        # ── Phase 3: SessionStart Hook ────────────────────────────
        print("\n--- Phase 3: SessionStart Hook ---")
        result2 = run_hook("sessionstart.py", json.dumps({"source": "compact"}))

        check("sessionstart exits 0", result2.returncode == 0,
              f"exit={result2.returncode}, stderr={result2.stderr[:200]}")
        check("sessionstart produces output", len(result2.stdout) > 0)
        check("output contains CONTEXT FOLDING",
              "CONTEXT FOLDING" in result2.stdout)
        check("output contains awareness header",
              "unfold_section" in result2.stdout and "fold_section" in result2.stdout)
        check("output references origami_guide",
              "origami_guide" in result2.stdout)

        # Check fold IDs appear in output
        for fold in state["folds"]:
            fid = fold["id"].upper().replace("FOLD-", "F")
            check(f"{fid} in sessionstart output", fid in result2.stdout)

        # ── Phase 3b: SessionStart with NO folds ──────────────────
        print("\n--- Phase 3b: SessionStart with No Folds ---")
        saved_state = json.loads(json.dumps(state))  # deep copy
        empty_state = {"version": 1, "session_id": None, "total_summary_tokens": 0, "folds": []}
        with open(state_path, "w") as f:
            json.dump(empty_state, f)

        result2b = run_hook("sessionstart.py", json.dumps({"source": "startup"}))

        check("sessionstart exits 0 with no folds", result2b.returncode == 0,
              f"exit={result2b.returncode}, stderr={result2b.stderr[:200]}")
        check("still injects awareness header",
              "CONTEXT FOLDING" in result2b.stdout)
        check("mentions no folds yet",
              "No folds" in result2b.stdout)
        check("mentions available tools",
              "unfold_section" in result2b.stdout)

        # Restore state
        with open(state_path, "w") as f:
            json.dump(saved_state, f, indent=2)

        # ── Phase 4: MCP Server - origami_guide ───────────────────
        print("\n--- Phase 4: MCP Server - origami_guide ---")
        resp = mcp_call("tools/call", {"name": "origami_guide", "arguments": {}})

        check("origami_guide returns response", resp is not None)
        if resp and "result" in resp:
            text = resp["result"]["content"][0]["text"]
            check("guide contains fold instructions",
                  "unfold" in text.lower() and "fold" in text.lower())
            check("guide mentions aggressive folding",
                  "aggressive" in text.lower() or "lean" in text.lower())
        else:
            check("guide has result content", False,
                  f"resp={json.dumps(resp)[:200] if resp else 'None'}")

        # ── Phase 5: MCP Server - list_folds ──────────────────────
        print("\n--- Phase 5: MCP Server - list_folds ---")
        resp = mcp_call("tools/call", {"name": "list_folds", "arguments": {}})

        check("list_folds returns response", resp is not None)
        if resp and "result" in resp:
            text = resp["result"]["content"][0]["text"]
            check("list shows fold entries", "F001" in text.upper())
            check("list shows token counts", "tok" in text)

        # ── Phase 6: MCP Server - unfold_section ──────────────────
        print("\n--- Phase 6: MCP Server - unfold_section ---")
        resp = mcp_call("tools/call",
                        {"name": "unfold_section", "arguments": {"fold_id": "fold-001"}})

        check("unfold returns response", resp is not None)
        if resp and "result" in resp:
            text = resp["result"]["content"][0]["text"]
            check("unfold contains UNFOLDED marker", "UNFOLDED" in text)
            check("unfold contains detail content", len(text) > 100,
                  f"got {len(text)} chars")

        # Verify state updated on disk
        with open(state_path) as f:
            state_after = json.load(f)
        fold_001 = next(f for f in state_after["folds"] if f["id"] == "fold-001")
        check("fold-001 status is unfolded", fold_001["status"] == "unfolded")

        # ── Phase 7: MCP Server - write_summary ───────────────────
        print("\n--- Phase 7: MCP Server - write_summary ---")
        new_summary = "auth.mid>fix: jwt.decode>jwt.verify | sig.validation.added | D:auth.mid.ts"
        resp = mcp_call("tools/call",
                        {"name": "write_summary",
                         "arguments": {"fold_id": "fold-001", "summary": new_summary}})

        check("write_summary returns response", resp is not None)
        if resp and "result" in resp:
            text = resp["result"]["content"][0]["text"]
            check("write_summary confirms update", "updated" in text.lower())

        # Verify on disk
        with open(state_path) as f:
            state_after2 = json.load(f)
        fold_001 = next(f for f in state_after2["folds"] if f["id"] == "fold-001")
        check("summary updated on disk", fold_001["summary"] == new_summary)

        # ── Phase 8: MCP Server - fold_section ────────────────────
        print("\n--- Phase 8: MCP Server - fold_section ---")
        resp = mcp_call("tools/call",
                        {"name": "fold_section", "arguments": {"fold_id": "fold-001"}})

        check("fold returns response", resp is not None)
        if resp and "result" in resp:
            text = resp["result"]["content"][0]["text"]
            check("fold contains FOLDED marker", "FOLDED" in text)
            check("fold shows summary", "auth.mid" in text)

        # Verify state
        with open(state_path) as f:
            state_after3 = json.load(f)
        fold_001 = next(f for f in state_after3["folds"] if f["id"] == "fold-001")
        check("fold-001 status back to folded", fold_001["status"] == "folded")

        # ── Phase 9: Error cases ──────────────────────────────────
        print("\n--- Phase 9: Error Cases ---")
        resp = mcp_call("tools/call",
                        {"name": "unfold_section", "arguments": {"fold_id": "fold-999"}})
        if resp and "result" in resp:
            text = resp["result"]["content"][0]["text"]
            check("unfold nonexistent fold returns error", "not found" in text.lower())

        resp = mcp_call("tools/call",
                        {"name": "fold_section", "arguments": {"fold_id": "fold-999"}})
        if resp and "result" in resp:
            text = resp["result"]["content"][0]["text"]
            check("fold nonexistent fold returns error", "not found" in text.lower())

        # ── Phase 10: Second compaction (idempotency) ─────────────
        print("\n--- Phase 10: Second Compaction (idempotency) ---")
        result3 = run_hook("precompact.py", hook_input)
        check("second precompact exits 0", result3.returncode == 0)

        with open(state_path) as f:
            state_after4 = json.load(f)
        check("fold count unchanged after re-run",
              len(state_after4["folds"]) == num_folds,
              f"was {num_folds}, now {len(state_after4['folds'])}")

    finally:
        os.unlink(transcript_path)
        cleanup()

    # ── Summary ───────────────────────────────────────────────────
    print("\n" + "=" * 60)
    total = PASS + FAIL
    print(f"RESULTS: {PASS}/{total} passed, {FAIL} failed")
    if FAIL == 0:
        print("ALL TESTS PASSED")
    print("=" * 60)

    sys.exit(1 if FAIL > 0 else 0)


if __name__ == "__main__":
    main()
