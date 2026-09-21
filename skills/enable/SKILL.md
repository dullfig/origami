---
name: enable
description: Use when the user invokes /origami:enable, or asks to enable origami, turn on origami, enable function hooks, or fix "origami is installed but function hooks are disabled".
---

# Enabling origami's function hooks

Origami's context-folding engine needs `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`
set for every Claude Code session. This skill sets it, once, in the user's
own settings file.

## Steps

1. Read `~/.claude/settings.json`.
   - If the file does not exist, treat its contents as `{}`.
   - If it exists but is not valid JSON, stop and tell the user the file is
     malformed and ask them to fix it before retrying — do not overwrite it.

2. Check `env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`.
   - If it is already a non-empty value, tell the user it is already set and
     make **no** changes to the file.

3. Otherwise, merge the flag in:
   - If the top-level `env` object does not exist, create it as
     `{ "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }`.
   - If `env` already exists, add the `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`
     key to it with value `"1"`, preserving every other key already in `env`
     and every other top-level key in the settings file. Never remove or
     rewrite anything you did not need to touch.
   - Write the merged JSON back to `~/.claude/settings.json`, preserving
     valid JSON formatting.

4. Tell the user:
   - The change takes effect the next time Claude Code starts (a fresh
     session, or a restart) — it does not apply to the current session.
   - Once restarted, context folding activates automatically; no further
     action is needed.

## Rules

- Never clobber unrelated `env` entries or other top-level settings keys.
- Never touch the file if the flag is already set.
- Keep the edit minimal: this skill's only job is merging one env var.
