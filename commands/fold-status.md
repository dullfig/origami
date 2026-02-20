# /fold-status

Show the current state of all context folds.

## Instructions

Call the `list_folds` MCP tool from the context-folding server.
Display the results as a formatted table showing:
- Fold ID
- Status (folded/unfolded)
- Summary preview (first 80 chars)
- Detail token count
- Relevance score

If no folds exist yet, inform the user that context folding hasn't
created any folds yet (folds are created during compaction).
