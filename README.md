# Origami

Context folding for Claude Code. Replaces lossy compaction with **variable-resolution context**: every conversation section keeps an always-visible self-compressed summary, with full detail stored on disk and expandable on demand.

## How It Works

```
Normal conversation flow
         │
         ▼
   Auto-compact triggers
         │
         ▼
   PreCompact hook ──► Save transcript sections as folds
         │              Run Haiku librarian for relevance scoring
         │              Return fold-aware compact instructions
         ▼
   Claude Code compaction (produces fold-aware summary)
         │
         ▼
   SessionStart hook ─► Inject fold index + relevant unfolded sections
         │
         ▼
   Conversation resumes with folded context
         │
   Opus calls unfold_section MCP tool as needed
```

### Core Concepts

- **Fold** — a logical section of conversation stored on disk with full detail
- **Summary** — self-compressed, always in context regardless of fold state
- **Fold State** — `folded` (summary only) or `unfolded` (full detail in context)
- **Librarian** — Haiku evaluates relevance and decides fold/unfold state each compaction cycle
- **Unfold Tool** — MCP tool Opus calls to expand any fold on demand

## Installation

### Prerequisites

- Node.js >= 18
- Python >= 3.9
- `ANTHROPIC_API_KEY` environment variable (for the Haiku librarian)

### Setup

```bash
git clone https://github.com/dullfig/origami.git
cd origami
npm install
pip install -r requirements.txt
```

Then add the plugin to your Claude Code project (copy or symlink into your project, or configure via Claude Code settings).

## Usage

The plugin works automatically during compaction. You can also use these commands:

| Command | Description |
|---------|-------------|
| `/fold-status` | Show all folds with their state and summaries |
| `/unfold <id>` | Manually expand a folded section |
| `/fold-reset` | Clear all fold state and start fresh |

### MCP Tools (called by the model)

| Tool | Description |
|------|-------------|
| `unfold_section(fold_id)` | Expand a fold to full detail |
| `fold_section(fold_id)` | Collapse back to summary-only |
| `list_folds()` | Show fold index |
| `write_summary(fold_id, summary)` | Update a fold's self-compressed summary |

## Data Storage

Fold state is stored at `.claude/context-folding/` in the project root:

```
.claude/context-folding/
├── state.json          # Fold index with summaries, scores, metadata
└── folds/
    ├── fold-001.md     # Full detail of section 1
    ├── fold-002.md     # Full detail of section 2
    └── ...
```

## Token Budget

Aggressive folding by default. Research ([Lost in the Middle](https://arxiv.org/abs/2307.03172), [context length vs. performance](https://arxiv.org/abs/2510.05381)) shows LLM performance degrades well before context is exhausted. The system targets:

- **20% of context window** max for injected content (40k tokens for a 200k window)
- **Max 3 sections unfolded** simultaneously
- **0.7 relevance threshold** to unfold (only highly relevant sections)

Summaries are always included regardless of budget. The model can still unfold on demand via the MCP tool when it needs specific detail.

## Architecture

- **Hooks** (Python): `PreCompact` parses transcripts and saves folds; `SessionStart` injects folded context
- **MCP Server** (Node.js): Stdio server providing unfold/fold/list/write_summary tools
- **Librarian** (Python + Haiku API): Relevance scoring for intelligent fold/unfold decisions
- **Skill**: Teaches the model how to use the folding system effectively

## License

MIT
