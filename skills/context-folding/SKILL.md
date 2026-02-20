# Context Folding

You have a **context folding** system active. It preserves your full
conversation history at variable resolution — every section has an
always-visible self-compressed summary, and full detail is stored on
disk, expandable on demand.

## Fold Index

After compaction you'll see a fold index:

```
[CONTEXT FOLDING — 5 sections, 14200 tokens stored]

[F001 | FOLDED | 3200 tok | rel:0.15]
auth.mid>refac: jwt.decode>jwt.verify | tok.refresh.chain.fix | D:auth.mid.ts,auth.svc.ts

[F002 | UNFOLDED | 2800 tok | rel:0.85]
<full detail visible>
```

Each entry shows: fold ID, status, detail token count, relevance score,
and the self-compressed summary.

## Available Tools

| Tool | When to use |
|------|-------------|
| `unfold_section(fold_id)` | You need specific code, errors, or decisions from a folded section |
| `fold_section(fold_id)` | You're done referencing a section — free up context space |
| `list_folds()` | See the full fold index with status and summaries |
| `write_summary(fold_id, summary)` | Create or update a fold's self-compressed summary |

## When to Unfold

- A user references something discussed in a folded section
- You need exact code, error messages, or file contents from earlier
- You're building on prior work and need precise details
- The summary alone is insufficient to answer accurately

## When to Fold Back

- You've finished using a section's detail
- Context is getting large and you need space
- The section is no longer relevant to the current task

## Writing Summaries

When you call `write_summary`, use this dense format — you are the
**only reader**, so maximise information density:

- Abbreviations: `>refac`, `>impl`, `>fix`, `>add`, `>mod`, `>del`
- Compress paths: `auth.middleware.ts` → `auth.mid.ts`
- Note cross-references: `"builds on F003"`
- Format: `topic>action: key.details | outcome | D:files`

**Example:**
```
auth.mid>refac: jwt.decode>jwt.verify | tok.refresh.chain.fix | D:auth.mid.ts,auth.svc.ts
```

## Token Awareness

Each fold shows its token count. Research shows LLM performance degrades
well before context is exhausted, so **aggressive folding is preferred**:
- Unfold ONLY what you actively need right now
- Fold sections back IMMEDIATELY when done
- Prefer re-reading a summary over keeping a section unfolded "just in case"
- Maximum 3 sections unfolded at once

The system enforces a tight token budget (20% of context window, max 3
simultaneous unfolds). Keep context lean - smaller context means better
reasoning on what's actually there.
