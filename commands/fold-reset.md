# /fold-reset

Clear all context folding state and start fresh.

## Instructions

1. Confirm with the user that they want to delete all fold state.
   This removes all stored fold summaries and detail — it cannot be undone.

2. If confirmed, delete the `.claude/context-folding/` directory
   (the entire fold storage).

3. Inform the user that fold state has been cleared. New folds will
   be created on the next compaction cycle.
