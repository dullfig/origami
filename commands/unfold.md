# /unfold <id>

Manually unfold a specific conversation section to see its full detail.

## Instructions

The user will provide a fold ID (e.g., "fold-001" or just "1" or "F001").

1. Normalise the ID to the format "fold-NNN" (e.g., "1" → "fold-001",
   "F003" → "fold-003").
2. Call the `unfold_section` MCP tool with the normalised fold_id.
3. Display the returned detail to the user.

If the fold is not found, list available folds using `list_folds`.
