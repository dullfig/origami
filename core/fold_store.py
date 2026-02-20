"""Read/write fold state and detail files to disk.

Fold storage lives at .claude/context-folding/ relative to cwd:
  state.json    - fold index with summaries, scores, metadata
  folds/        - full detail markdown files (fold-001.md, etc.)
"""

import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from .token_counter import estimate_tokens

FOLD_DIR = os.path.join(".claude", "context-folding")
STATE_FILE = "state.json"
FOLDS_DIR = "folds"


class FoldStore:
    def __init__(self, base_dir=None):
        root = Path(base_dir) if base_dir else Path.cwd()
        self.base_dir = root / FOLD_DIR
        self.state_path = self.base_dir / STATE_FILE
        self.folds_path = self.base_dir / FOLDS_DIR

    def ensure_dirs(self):
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.folds_path.mkdir(parents=True, exist_ok=True)

    def load_state(self):
        """Load fold state from disk, or return empty state."""
        if self.state_path.exists():
            with open(self.state_path, "r", encoding="utf-8") as f:
                return json.load(f)
        return {
            "version": 1,
            "session_id": None,
            "total_summary_tokens": 0,
            "folds": [],
        }

    def save_state(self, state):
        """Write fold state to disk."""
        self.ensure_dirs()
        with open(self.state_path, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)

    def save_fold_detail(self, fold_id, content):
        """Write full detail for a fold to folds/fold-NNN.md."""
        self.ensure_dirs()
        path = self.folds_path / f"{fold_id}.md"
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)

    def read_fold_detail(self, fold_id):
        """Read full detail for a fold. Returns None if not found."""
        path = self.folds_path / f"{fold_id}.md"
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
        return None

    def next_fold_id(self, state):
        """Generate the next sequential fold ID."""
        if not state["folds"]:
            return "fold-001"
        max_num = max(int(f["id"].split("-")[1]) for f in state["folds"])
        return f"fold-{max_num + 1:03d}"

    def add_fold(self, state, fold_id, summary, detail_content,
                 turn_range, files_touched=None, tags=None):
        """Create a new fold: save detail to disk, add entry to state."""
        self.save_fold_detail(fold_id, detail_content)

        fold = {
            "id": fold_id,
            "status": "folded",
            "summary": summary,
            "summary_tokens": estimate_tokens(summary),
            "detail_tokens": estimate_tokens(detail_content),
            "detail_file": f"folds/{fold_id}.md",
            "turn_range": turn_range,
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "relevance_score": 0.0,
            "files_touched": files_touched or [],
            "tags": tags or [],
        }

        state["folds"].append(fold)
        state["total_summary_tokens"] = sum(
            f["summary_tokens"] for f in state["folds"]
        )
        return fold

    def update_fold_status(self, state, fold_id, status):
        """Set a fold's status to 'folded' or 'unfolded'."""
        for fold in state["folds"]:
            if fold["id"] == fold_id:
                fold["status"] = status
                return True
        return False

    def update_fold_summary(self, state, fold_id, summary):
        """Replace a fold's summary text and recalculate token counts."""
        for fold in state["folds"]:
            if fold["id"] == fold_id:
                fold["summary"] = summary
                fold["summary_tokens"] = estimate_tokens(summary)
                state["total_summary_tokens"] = sum(
                    f["summary_tokens"] for f in state["folds"]
                )
                return True
        return False

    def update_fold_relevance(self, state, fold_id, score):
        """Update a fold's relevance score."""
        for fold in state["folds"]:
            if fold["id"] == fold_id:
                fold["relevance_score"] = score
                return True
        return False

    def get_fold(self, state, fold_id):
        """Get a single fold entry by ID."""
        for fold in state["folds"]:
            if fold["id"] == fold_id:
                return fold
        return None

    def clear_state(self):
        """Delete all fold state and detail files."""
        if self.base_dir.exists():
            shutil.rmtree(self.base_dir)
