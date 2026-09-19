# Origami Re-brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Origami's Python/MCP architecture with a single Claude Code function-hooks (Mods) module that keeps the live context lean via mass-triggered fold sweeps, librarian-written stubs, and hydrate/unpin tools.

**Architecture:** One TypeScript hooks module registered via `hooks/hooks.json` `{"modules": ["./origami.ts"]}`. Pure logic (candidate selection, message rebuilding) lives in `rebuild.ts`; Haiku prompting/parsing in `librarian.ts`; persistence over `$.fs`/`$.store` in `store.ts`; `origami.ts` only wires hooks and tools. Every failure path falls through to built-in compaction.

**Tech Stack:** TypeScript (engine-hosted, no Node/DOM, no npm dependencies), Claude Code function hooks (early access), `claude plugin test` for all tests.

**Spec:** `docs/superpowers/specs/2026-09-19-origami-rebrain-design.md`

## Global Constraints

- Claude Code >= 2.1.259 with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` exported in every dev/test shell.
- Zero external dependencies: no npm packages, no API keys, no Python, no separate processes.
- The hooks module runs in the engine's own environment: no Node, no DOM, no `process`, no direct `fs` — only the `$` surface.
- Librarian invariant: the librarian always sees the full content it judges; never feed it omission notes.
- Config defaults (from spec, verbatim): `foldAgeTurns` 3, `minFoldMass` 20000, `workingSetBudget` 100000, `preserveRecentTurns` 3, `minReductionRatio` 0.15, `pinAfterHydrations` 2, `librarianModel` "haiku".
- Main thread only: any event carrying `agentId` is passed through untouched.
- All tests run with `claude plugin test .` from the repo root (the plugin folder is the repo root). The kit is imported from `'claude-code/testing'`; its exact `mock` affordances are documented in `types/claude-code.d.ts` — when a test below doesn't match the kit's real API, adapt the mechanics but keep the asserted behavior.
- Commit after every task with the attribution trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

### API shapes this plan codes against (verified from engine-generated declarations, Claude Code 2.1.274)

```ts
// Events
// on('turn.complete', ($, e, next) => ...)         e: { agentId?: string, ... }
// on('session.compact', ($, e, next) => ...)       e: SessionCompactInput
type SessionCompactInput = {
  trigger: 'manual' | 'auto' | 'plugin' | 'precompute';
  agentId?: string;            // present for subagent/fork transcripts
  instructions?: string;
  messages: readonly SessionMessage[];  // each carries an opaque `handle`
};
// hook returns { messages, tokensBefore?, tokensAfter? } or { skip: string }

type SessionMessage = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: ToolUseSummary[];          // assistant tool_use blocks
  toolResults?: ToolResultSummary[];   // user tool_result blocks
  handle?: string;  // keep it => engine reuses its own message whole;
                    // omit it => message is rebuilt from role/text/tool blocks
};
type ToolUseSummary = { tool_use_id: string; tool: string; input: Record<string, unknown>;
                        result?: unknown; text?: string; isError?: true };
type ToolResultSummary = { tool_use_id: string; text: string; isError: boolean; result?: unknown };

// $ surface used:
// $.session.usage() -> { context: { percent?: number, ... }, ... }
// $.session.compact({ instructions? }) -> { messages,... } | { skip }   (trigger 'plugin')
// $.session.messages() -> SessionMessage[] (no handles)
// $.model.complete({ model, prompt, system?, maxTokens? }) -> reply text
// $.fs.read(path) / $.fs.write(path, text) / $.fs.exists(path)
// $.store.get(key) -> unknown / $.store.set(key, value) / $.store.keys()
// $.tool.register({ name, description, inputSchema? })  // model calls mcp__origami__<name>
// serve registered tools: on('tool.call', { tool: 'mcp__origami__hydrate' }, handler)
// $.ui.log(text)
// Module entry: export const register: Register = (on, options) => { ... }
```

---

### Task 1: Scaffold, v0 teardown, generated types

**Files:**
- Delete: `core/`, `server/`, `hooks/precompact.py`, `hooks/sessionstart.py`, `commands/`, `requirements.txt`, `package.json`, `package-lock.json`, `test_e2e.py`, `.mcp.json`
- Create: `.claude-plugin/plugin.json` (replace), `hooks/hooks.json` (replace), `hooks/origami.ts`, `tsconfig.json`
- Create (generated): `types/claude-code.d.ts`

**Interfaces:**
- Produces: `OrigamiConfig` type and `readConfig(options)` in `hooks/origami.ts` — every later task imports config from here.

- [ ] **Step 1: Verify environment**

Run: `claude --version`
Expected: >= 2.1.259. If lower: STOP, report to user (Global Constraint unmet).

- [ ] **Step 2: Delete v0**

```bash
git rm -r core server commands hooks/precompact.py hooks/sessionstart.py requirements.txt package.json package-lock.json test_e2e.py .mcp.json
```

- [ ] **Step 3: Write plugin manifest with userConfig**

`.claude-plugin/plugin.json`:
```json
{
  "name": "origami",
  "description": "Variable-resolution context: folds bulky stale tool output to disk behind always-visible stubs; hydrate() recovers detail on demand.",
  "version": "1.0.0",
  "userConfig": {
    "foldAgeTurns": { "type": "number", "default": 3, "description": "Results younger than this many turns are never fold candidates" },
    "minFoldMass": { "type": "number", "default": 20000, "description": "Candidate token mass that triggers a sweep" },
    "workingSetBudget": { "type": "number", "default": 100000, "description": "Absolute live-context tokens; above it sweeps turn aggressive" },
    "preserveRecentTurns": { "type": "number", "default": 3, "description": "Turns the rebuilder never touches" },
    "minReductionRatio": { "type": "number", "default": 0.15, "description": "Below this estimated reduction a sweep is skipped" },
    "pinAfterHydrations": { "type": "number", "default": 2, "description": "Hydration count at which a fold is pinned open" },
    "librarianModel": { "type": "string", "default": "haiku", "description": "Model alias for the librarian" }
  }
}
```

(If `claude plugin test` later rejects this `userConfig` schema shape, copy the exact shape from `tamaratran/fast-jev-compaction`'s `.claude-plugin/plugin.json` — it is the working reference for Mods manifests.)

- [ ] **Step 4: Write hooks.json and module skeleton**

`hooks/hooks.json`:
```json
{ "modules": ["./origami.ts"] }
```

`hooks/origami.ts`:
```ts
import type { Register } from 'claude-code';

export type OrigamiConfig = {
  foldAgeTurns: number;
  minFoldMass: number;
  workingSetBudget: number;
  preserveRecentTurns: number;
  minReductionRatio: number;
  pinAfterHydrations: number;
  librarianModel: string;
};

const DEFAULTS: OrigamiConfig = {
  foldAgeTurns: 3,
  minFoldMass: 20000,
  workingSetBudget: 100000,
  preserveRecentTurns: 3,
  minReductionRatio: 0.15,
  pinAfterHydrations: 2,
  librarianModel: 'haiku',
};

export function readConfig(options: unknown): OrigamiConfig {
  const o = (options ?? {}) as Partial<Record<keyof OrigamiConfig, unknown>>;
  const num = (k: keyof OrigamiConfig) =>
    typeof o[k] === 'number' && Number.isFinite(o[k] as number) ? (o[k] as number) : (DEFAULTS[k] as number);
  return {
    foldAgeTurns: num('foldAgeTurns'),
    minFoldMass: num('minFoldMass'),
    workingSetBudget: num('workingSetBudget'),
    preserveRecentTurns: num('preserveRecentTurns'),
    minReductionRatio: num('minReductionRatio'),
    pinAfterHydrations: num('pinAfterHydrations'),
    librarianModel: typeof o.librarianModel === 'string' ? o.librarianModel : DEFAULTS.librarianModel,
  };
}

export const register: Register = (on, options) => {
  const config = readConfig(options);
  void config; // wired in later tasks
};
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true,
    "paths": { "claude-code": ["./types/claude-code.d.ts"], "claude-code/testing": ["./types/claude-code.d.ts"] }
  },
  "include": ["hooks/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 5: Generate pinned types**

In an interactive `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude` session in this repo, run `/plugin-types` and save the output as `types/claude-code.d.ts`. If this step needs the user (interactive-only), ask them to run it and pause the task. The file's first line names the Claude Code version — record it in the README later (Task 9).

- [ ] **Step 6: Write the loading test**

`tests/loading.test.ts`:
```ts
import { test, expect } from 'claude-code/testing';
import { readConfig } from '../hooks/origami';

test('module loads and defaults apply', async () => {
  const c = readConfig(undefined);
  expect(c.foldAgeTurns).toBe(3);
  expect(c.minFoldMass).toBe(20000);
  expect(c.librarianModel).toBe('haiku');
});

test('user config overrides defaults, garbage ignored', async () => {
  const c = readConfig({ minFoldMass: 5000, foldAgeTurns: 'nonsense' });
  expect(c.minFoldMass).toBe(5000);
  expect(c.foldAgeTurns).toBe(3);
});
```

- [ ] **Step 7: Run tests**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: PASS (2 tests). A load failure here means the manifest or hooks.json shape is wrong — fix against the fast-jev reference before proceeding.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: scaffold function-hooks module, retire v0 Python/MCP architecture"
```

---

### Task 2: rebuild.ts — turn ages, token estimate, candidate selection

**Files:**
- Create: `hooks/rebuild.ts`
- Test: `tests/candidates.test.ts`

**Interfaces:**
- Consumes: `OrigamiConfig` from `hooks/origami.ts`; `SessionMessage` from `claude-code`.
- Produces (later tasks rely on these exact signatures):
  - `estimateTokens(text: string): number`
  - `turnAges(messages: readonly SessionMessage[]): number[]` — per message index, age in turns (0 = newest turn). A turn starts at each user message with nonempty `text` (a human prompt); a user message holding only `toolResults` belongs to the current turn.
  - `type Candidate = { messageIndex: number; resultIndex: number; toolUseId: string; tool: string; input: Record<string, unknown>; text: string; sizeTokens: number; ageTurns: number }`
  - `selectCandidates(messages: readonly SessionMessage[], excludedToolUseIds: ReadonlySet<string>, cfg: OrigamiConfig, aggressive: boolean): Candidate[]`
  - `candidateMass(candidates: readonly Candidate[]): number`

- [ ] **Step 1: Write failing tests**

`tests/candidates.test.ts`:
```ts
import { test, expect } from 'claude-code/testing';
import { estimateTokens, turnAges, selectCandidates, candidateMass } from '../hooks/rebuild';
import { readConfig } from '../hooks/origami';
import type { SessionMessage } from 'claude-code';

const cfg = readConfig(undefined);

function msg(m: Partial<SessionMessage> & Pick<SessionMessage, 'role'>): SessionMessage {
  return { text: '', toolUses: [], ...m } as SessionMessage;
}
function bigResult(id: string, chars = 8000) {
  return { tool_use_id: id, text: 'x'.repeat(chars), isError: false };
}
// 5 turns: t0..t4 (t4 newest). Turn 1 holds a big Read result.
function transcript(): SessionMessage[] {
  const out: SessionMessage[] = [msg({ role: 'user', text: 'turn0 prompt' }), msg({ role: 'assistant', text: 'reply0' })];
  out.push(msg({ role: 'user', text: 'turn1 prompt' }));
  out.push(msg({ role: 'assistant', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } }] }));
  out.push(msg({ role: 'user', toolResults: [bigResult('t1')] }));
  out.push(msg({ role: 'assistant', text: 'reply1' }));
  for (let i = 2; i <= 4; i++) {
    out.push(msg({ role: 'user', text: `turn${i} prompt` }), msg({ role: 'assistant', text: `reply${i}` }));
  }
  return out;
}

test('estimateTokens ~ chars/4', async () => {
  expect(estimateTokens('x'.repeat(4000))).toBe(1000);
});

test('turnAges: tool-result-only user message stays in its turn', async () => {
  const ages = turnAges(transcript());
  expect(ages[0]).toBe(4);            // turn0 under 5 turns total
  expect(ages[4]).toBe(3);            // the t1 result row belongs to turn1
  expect(ages[ages.length - 1]).toBe(0);
});

test('selectCandidates: old big result is a candidate; young and excluded are not', async () => {
  const t = transcript();
  const c1 = selectCandidates(t, new Set(), cfg, false);
  expect(c1.length).toBe(1);
  expect(c1[0].toolUseId).toBe('t1');
  expect(c1[0].ageTurns).toBe(3);
  expect(candidateMass(c1)).toBe(estimateTokens('x'.repeat(8000)));
  // excluded (already folded or pinned) never reappears
  expect(selectCandidates(t, new Set(['t1']), cfg, false).length).toBe(0);
});

test('selectCandidates: aggressive treats foldAgeTurns as 1', async () => {
  const t = transcript();
  // add a result in turn 4 (age 0) and one in turn 3 (age 1)
  t.push(msg({ role: 'assistant', toolUses: [{ tool_use_id: 't9', tool: 'Bash', input: { command: 'ls' } }] }));
  t.push(msg({ role: 'user', toolResults: [bigResult('t9')] }));
  const normal = selectCandidates(t, new Set(), cfg, false);
  expect(normal.some(c => c.toolUseId === 't9')).toBe(false); // age 0 < 3
  const agg = selectCandidates(t, new Set(), cfg, true);
  expect(agg.some(c => c.toolUseId === 't9')).toBe(false);    // age 0 < 1 still protects the live turn
});

test('small results are never candidates', async () => {
  const t = transcript();
  t[4] = msg({ role: 'user', toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false }] });
  expect(selectCandidates(t, new Set(), cfg, false).length).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: FAIL — `../hooks/rebuild` not found.

- [ ] **Step 3: Implement**

`hooks/rebuild.ts`:
```ts
import type { SessionMessage } from 'claude-code';
import type { OrigamiConfig } from './origami';

const MIN_CANDIDATE_TOKENS = 256; // below this a fold saves nothing worth a stub

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function turnAges(messages: readonly SessionMessage[]): number[] {
  const turnOf: number[] = [];
  let turn = -1;
  for (const m of messages) {
    if (m.role === 'user' && m.text.trim() !== '') turn += 1;
    turnOf.push(Math.max(turn, 0));
  }
  const newest = Math.max(turn, 0);
  return turnOf.map(t => newest - t);
}

export type Candidate = {
  messageIndex: number;
  resultIndex: number;
  toolUseId: string;
  tool: string;
  input: Record<string, unknown>;
  text: string;
  sizeTokens: number;
  ageTurns: number;
};

export function selectCandidates(
  messages: readonly SessionMessage[],
  excludedToolUseIds: ReadonlySet<string>,
  cfg: OrigamiConfig,
  aggressive: boolean,
): Candidate[] {
  const ages = turnAges(messages);
  const minAge = Math.max(aggressive ? 1 : cfg.foldAgeTurns, 1);
  const toolByUseId = new Map<string, { tool: string; input: Record<string, unknown> }>();
  for (const m of messages) {
    for (const u of m.toolUses) toolByUseId.set(u.tool_use_id, { tool: u.tool, input: u.input });
  }
  const out: Candidate[] = [];
  messages.forEach((m, mi) => {
    if (mi === 0) return; // first message is pinned by invariant
    (m.toolResults ?? []).forEach((r, ri) => {
      if (excludedToolUseIds.has(r.tool_use_id)) return;
      if (ages[mi] < minAge) return;
      const sizeTokens = estimateTokens(r.text);
      if (sizeTokens < MIN_CANDIDATE_TOKENS) return;
      const call = toolByUseId.get(r.tool_use_id);
      out.push({
        messageIndex: mi, resultIndex: ri, toolUseId: r.tool_use_id,
        tool: call?.tool ?? 'unknown', input: call?.input ?? {},
        text: r.text, sizeTokens, ageTurns: ages[mi],
      });
    });
  });
  return out;
}

export function candidateMass(candidates: readonly Candidate[]): number {
  return candidates.reduce((sum, c) => sum + c.sizeTokens, 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add hooks/rebuild.ts tests/candidates.test.ts
git commit -m "feat: candidate selection with turn ages and token mass"
```

---

### Task 3: rebuild.ts — rebuild() with all spec invariants

**Files:**
- Modify: `hooks/rebuild.ts` (append)
- Test: `tests/rebuild.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `estimateTokens`, `turnAges` from Task 2.
- Produces:
  - `type FoldDecision = { toolUseId: string; foldId: string; stub: string }`
  - `type RestoreDecision = { toolUseId: string; foldId: string; body: string }` (pinned folds being reopened)
  - `stubText(foldId: string, tool: string, stub: string): string` — the exact text placed in a folded result slot
  - `rebuild(messages: readonly SessionMessage[], folds: readonly FoldDecision[], restores: readonly RestoreDecision[], cfg: OrigamiConfig, aggressive?: boolean): { kind: 'rebuilt'; messages: SessionMessage[]; tokensBefore: number; tokensAfter: number } | { kind: 'insufficient'; ratio: number }` — when `aggressive` is true, the recent-turns guard shrinks to 1 (only the live turn is protected), matching the aggressive fold age

- [ ] **Step 1: Write failing tests**

`tests/rebuild.test.ts`:
```ts
import { test, expect } from 'claude-code/testing';
import { rebuild, stubText, estimateTokens } from '../hooks/rebuild';
import { readConfig } from '../hooks/origami';
import type { SessionMessage } from 'claude-code';

const cfg = readConfig(undefined);

function transcript(): SessionMessage[] {
  return [
    { role: 'user', text: 'turn0', toolUses: [], handle: 'h0' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } }], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'x'.repeat(8000), isError: false }], handle: 'h2' },
    { role: 'assistant', text: 'done reading', toolUses: [], handle: 'h3' },
    { role: 'user', text: 'turn1', toolUses: [], handle: 'h4' },
    { role: 'assistant', text: 'r1', toolUses: [], handle: 'h5' },
    { role: 'user', text: 'turn2', toolUses: [], handle: 'h6' },
    { role: 'assistant', text: 'r2', toolUses: [], handle: 'h7' },
    { role: 'user', text: 'turn3', toolUses: [], handle: 'h8' },
    { role: 'assistant', text: 'r3', toolUses: [], handle: 'h9' },
  ];
}
const fold = { toolUseId: 't1', foldId: 'fold-001', stub: 'Read a.ts — the alpha module, defines X.' };

test('folded result becomes stub; untouched messages keep handles; text verbatim', async () => {
  const r = rebuild(transcript(), [fold], [], cfg);
  if (r.kind !== 'rebuilt') throw new Error('expected rebuilt');
  const folded = r.messages[2];
  expect(folded.handle).toBe(undefined);                       // rebuilt message drops its handle
  expect(folded.toolResults![0].text).toBe(stubText('fold-001', 'Read', fold.stub));
  expect(folded.toolResults![0].tool_use_id).toBe('t1');       // pair intact
  expect(r.messages[1].handle).toBe('h1');                     // neighbor untouched
  expect(r.messages[3].text).toBe('done reading');             // assistant text verbatim
  expect(r.messages.length).toBe(10);                          // nothing dropped
  expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
});

test('restore puts pinned body back inline', async () => {
  const t = transcript();
  t[2] = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: stubText('fold-001', 'Read', 'stub'), isError: false }], handle: 'h2' };
  const r = rebuild(t, [], [{ toolUseId: 't1', foldId: 'fold-001', body: 'FULL BODY '.repeat(400) }], cfg);
  if (r.kind !== 'rebuilt') throw new Error('expected rebuilt');
  expect(r.messages[2].toolResults![0].text).toBe('FULL BODY '.repeat(400));
});

test('messages in the newest preserveRecentTurns turns are never rebuilt', async () => {
  // fold targets t1 which lives in turn0 of a 4-turn transcript: allowed.
  // A decision naming a result inside the recent window must be refused loudly.
  const t = transcript();
  t.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 't9', tool: 'Bash', input: {} }], handle: 'h10' });
  t.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't9', text: 'y'.repeat(8000), isError: false }], handle: 'h11' });
  let threw = false;
  try { rebuild(t, [{ toolUseId: 't9', foldId: 'fold-002', stub: 's' }], [], cfg); } catch { threw = true; }
  expect(threw).toBe(true);
});

test('insufficient reduction reports instead of rebuilding', async () => {
  const t = transcript();
  t[2] = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'x'.repeat(1200), isError: false }], handle: 'h2' };
  const r = rebuild(t, [fold], [], cfg);
  expect(r.kind).toBe('insufficient');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: FAIL — `rebuild`/`stubText` not exported.

- [ ] **Step 3: Implement (append to `hooks/rebuild.ts`)**

```ts
export type FoldDecision = { toolUseId: string; foldId: string; stub: string };
export type RestoreDecision = { toolUseId: string; foldId: string; body: string };

export function stubText(foldId: string, tool: string, stub: string): string {
  return `[origami ${foldId} · ${tool} result folded] ${stub} — call hydrate("${foldId}") for the full content.`;
}

export type RebuildOutcome =
  | { kind: 'rebuilt'; messages: SessionMessage[]; tokensBefore: number; tokensAfter: number }
  | { kind: 'insufficient'; ratio: number };

export function rebuild(
  messages: readonly SessionMessage[],
  folds: readonly FoldDecision[],
  restores: readonly RestoreDecision[],
  cfg: OrigamiConfig,
  aggressive = false,
): RebuildOutcome {
  const protectedTurns = aggressive ? 1 : cfg.preserveRecentTurns;
  const ages = turnAges(messages);
  const foldByUseId = new Map(folds.map(f => [f.toolUseId, f]));
  const restoreByUseId = new Map(restores.map(r => [r.toolUseId, r]));
  const massOf = (ms: readonly SessionMessage[]) =>
    ms.reduce((s, m) => s + estimateTokens(m.text)
      + (m.toolResults ?? []).reduce((a, r) => a + estimateTokens(r.text), 0)
      + m.toolUses.reduce((a, u) => a + estimateTokens(JSON.stringify(u.input)), 0), 0);
  const tokensBefore = massOf(messages);

  const out: SessionMessage[] = messages.map((m, mi) => {
    const results = m.toolResults ?? [];
    const touched = results.some(r => foldByUseId.has(r.tool_use_id) || restoreByUseId.has(r.tool_use_id));
    if (!touched) return m as SessionMessage;
    if (mi === 0) throw new Error('origami invariant: first message is pinned');
    if (ages[mi] < protectedTurns) {
      throw new Error(`origami invariant: decision targets a message inside the protected recent turns (age ${ages[mi]})`);
    }
    const toolByUseId = new Map<string, string>();
    for (const mm of messages) for (const u of mm.toolUses) toolByUseId.set(u.tool_use_id, u.tool);
    return {
      role: m.role,
      text: m.text,
      toolUses: m.toolUses,
      toolResults: results.map(r => {
        const f = foldByUseId.get(r.tool_use_id);
        if (f) return { tool_use_id: r.tool_use_id, text: stubText(f.foldId, toolByUseId.get(r.tool_use_id) ?? 'tool', f.stub), isError: r.isError };
        const p = restoreByUseId.get(r.tool_use_id);
        if (p) return { tool_use_id: r.tool_use_id, text: p.body, isError: r.isError };
        return r;
      }),
      // no handle: this message is rebuilt
    };
  });

  const tokensAfter = massOf(out);
  const ratio = tokensBefore > 0 ? (tokensBefore - tokensAfter) / tokensBefore : 0;
  const restoring = restores.length > 0; // reopening pins may legitimately grow the context
  if (!restoring && ratio < cfg.minReductionRatio) return { kind: 'insufficient', ratio };
  return { kind: 'rebuilt', messages: out, tokensBefore, tokensAfter };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: PASS (all, including Task 2's).

- [ ] **Step 5: Commit**

```bash
git add hooks/rebuild.ts tests/rebuild.test.ts
git commit -m "feat: rebuild() enforcing fold invariants, stubs, restores, reduction gate"
```

---

### Task 4: store.ts — fold index, bodies, event log

**Files:**
- Create: `hooks/store.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: `$.fs` (`read`, `write`, `exists`), `$.store` (`get`, `set`, `keys`) — passed in as the `$` engine interface.
- Produces:
  - `type FoldEntry = { id: string; stub: string; state: 'folded' | 'pinned'; tool: string; toolUseId: string; originAge: number; sizeTokens: number; hydrations: number }` — `toolUseId` is how later sweeps exclude pinned folds from candidate selection after their content has been restored inline
  - `newFoldId($): Promise<string>` — `fold-001`, `fold-002`, … (counter at store key `origami:seq`)
  - `putFold($, entry: FoldEntry, body: string): Promise<void>` — index at `origami:fold:<id>`, body at `.claude/origami/folds/<id>.md`
  - `getFold($, id: string): Promise<{ entry: FoldEntry; body: string } | undefined>`
  - `setFold($, entry: FoldEntry): Promise<void>` (index update only)
  - `allFolds($): Promise<FoldEntry[]>`
  - `appendLog($, record: Record<string, unknown>): Promise<void>` — JSONL line appended to `.claude/origami/origami.log` (read-modify-write; `$.fs` has no append)

- [ ] **Step 1: Write failing tests**

`tests/store.test.ts`:
```ts
import { test, expect } from 'claude-code/testing';
import { newFoldId, putFold, getFold, setFold, allFolds, appendLog } from '../hooks/store';

test('fold ids increment and zero-pad', async ($) => {
  expect(await newFoldId($)).toBe('fold-001');
  expect(await newFoldId($)).toBe('fold-002');
});

test('putFold/getFold round-trips entry and body', async ($) => {
  const entry = { id: 'fold-001', stub: 's', state: 'folded' as const, tool: 'Read', toolUseId: 'tA', originAge: 3, sizeTokens: 2000, hydrations: 0 };
  await putFold($, entry, '# body\ncontent');
  const got = await getFold($, 'fold-001');
  expect(got!.entry.stub).toBe('s');
  expect(got!.body).toBe('# body\ncontent');
  expect(await getFold($, 'fold-999')).toBe(undefined);
});

test('setFold updates state; allFolds lists entries', async ($) => {
  const entry = { id: 'fold-001', stub: 's', state: 'folded' as const, tool: 'Read', toolUseId: 'tA', originAge: 3, sizeTokens: 2000, hydrations: 0 };
  await putFold($, entry, 'b');
  await setFold($, { ...entry, state: 'pinned', hydrations: 2 });
  const all = await allFolds($);
  expect(all.length).toBe(1);
  expect(all[0].state).toBe('pinned');
});

test('appendLog appends JSONL lines', async ($) => {
  await appendLog($, { event: 'sweep', tokensBefore: 100 });
  await appendLog($, { event: 'hydrate', foldId: 'fold-001' });
  const raw = await $.fs.read('.claude/origami/origami.log');
  const lines = String(raw).trim().split('\n').map(l => JSON.parse(l));
  expect(lines.length).toBe(2);
  expect(lines[1].event).toBe('hydrate');
});
```

(The testing kit provides `$` with mock `store` and `fs`. If `$.fs.read` on a missing file throws rather than returning undefined, adapt `appendLog`/`getFold` accordingly — the tests' asserted behavior stands.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: FAIL — `../hooks/store` not found.

- [ ] **Step 3: Implement**

`hooks/store.ts`:
```ts
import type { EngineInterface } from 'claude-code';

export type FoldEntry = {
  id: string; stub: string; state: 'folded' | 'pinned';
  tool: string; toolUseId: string; originAge: number; sizeTokens: number; hydrations: number;
};

const SEQ = 'origami:seq';
const FOLD = (id: string) => `origami:fold:${id}`;
const BODY = (id: string) => `.claude/origami/folds/${id}.md`;
const LOG = '.claude/origami/origami.log';

export async function newFoldId($: EngineInterface): Promise<string> {
  const n = Number((await $.store.get(SEQ)) ?? 0) + 1;
  await $.store.set(SEQ, n);
  return `fold-${String(n).padStart(3, '0')}`;
}

export async function putFold($: EngineInterface, entry: FoldEntry, body: string): Promise<void> {
  await $.fs.write(BODY(entry.id), body);
  await $.store.set(FOLD(entry.id), entry);
}

export async function getFold($: EngineInterface, id: string): Promise<{ entry: FoldEntry; body: string } | undefined> {
  const entry = (await $.store.get(FOLD(id))) as FoldEntry | undefined;
  if (!entry) return undefined;
  const body = String(await $.fs.read(BODY(id)));
  return { entry, body };
}

export async function setFold($: EngineInterface, entry: FoldEntry): Promise<void> {
  await $.store.set(FOLD(entry.id), entry);
}

export async function allFolds($: EngineInterface): Promise<FoldEntry[]> {
  const keys = (await $.store.keys()).filter((k: string) => k.startsWith('origami:fold:'));
  const out: FoldEntry[] = [];
  for (const k of keys) {
    const e = (await $.store.get(k)) as FoldEntry | undefined;
    if (e) out.push(e);
  }
  return out;
}

export async function appendLog($: EngineInterface, record: Record<string, unknown>): Promise<void> {
  let prior = '';
  try { if (await $.fs.exists(LOG)) prior = String(await $.fs.read(LOG)); } catch { prior = ''; }
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  await $.fs.write(LOG, prior === '' ? line + '\n' : prior + line + '\n');
}
```

(If `EngineInterface` is not the exported name for `$`'s type in the generated declarations, use the name the declarations export — check the `import type { Register, On, EngineInterface } from 'claude-code'` line in `types/claude-code.d.ts`'s preamble.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/store.ts tests/store.test.ts
git commit -m "feat: fold store over \$.fs/\$.store with single JSONL event log"
```

---

### Task 5: librarian.ts — prompt build and reply parse (pure), thin model call

**Files:**
- Create: `hooks/librarian.ts`
- Test: `tests/librarian.test.ts`

**Interfaces:**
- Consumes: `Candidate` from `hooks/rebuild.ts`; `$.model.complete`.
- Produces:
  - `buildSweepPrompt(candidates: readonly Candidate[], aggressive: boolean): string` — includes each candidate's FULL text (librarian invariant), tagged `<candidate id="...">`
  - `type LibrarianDecision = { toolUseId: string; action: 'keep' | 'fold'; stub: string }`
  - `parseSweepReply(reply: string, expectedIds: readonly string[]): LibrarianDecision[]` — throws on any missing/unknown id or malformed block
  - `runLibrarian($, model: string, candidates: readonly Candidate[], aggressive: boolean): Promise<{ decisions: LibrarianDecision[]; inputTokens: number; outputTokens: number }>` (token figures via `estimateTokens` on prompt/reply — logged, not billed-exact)

- [ ] **Step 1: Write failing tests**

`tests/librarian.test.ts`:
```ts
import { test, expect } from 'claude-code/testing';
import { buildSweepPrompt, parseSweepReply } from '../hooks/librarian';
import type { Candidate } from '../hooks/rebuild';

const cand: Candidate = {
  messageIndex: 2, resultIndex: 0, toolUseId: 'tA', tool: 'Read',
  input: { file_path: 'src/auth.ts' }, text: 'FULL FILE CONTENT '.repeat(100),
  sizeTokens: 450, ageTurns: 4,
};

test('prompt carries full candidate content, never an omission note', async () => {
  const p = buildSweepPrompt([cand], false);
  expect(p.includes('FULL FILE CONTENT')).toBe(true);
  expect(p.includes('omitted')).toBe(false);
  expect(p.includes('<candidate id="tA"')).toBe(true);
});

test('aggressive mode states the budget pressure', async () => {
  expect(buildSweepPrompt([cand], true).includes('over budget')).toBe(true);
  expect(buildSweepPrompt([cand], false).includes('over budget')).toBe(false);
});

test('parse round-trips well-formed replies', async () => {
  const reply = `<decision id="tA" action="fold">Read src/auth.ts (JWT validation, refresh flow).</decision>`;
  const d = parseSweepReply(reply, ['tA']);
  expect(d.length).toBe(1);
  expect(d[0].action).toBe('fold');
  expect(d[0].stub.includes('JWT')).toBe(true);
});

test('parse throws on missing or unknown ids', async () => {
  let threw = 0;
  try { parseSweepReply('<decision id="tB" action="keep"></decision>', ['tA']); } catch { threw++; }
  try { parseSweepReply('no decisions here', ['tA']); } catch { threw++; }
  expect(threw).toBe(2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`hooks/librarian.ts`:
```ts
import type { EngineInterface } from 'claude-code';
import { estimateTokens, type Candidate } from './rebuild';

export type LibrarianDecision = { toolUseId: string; action: 'keep' | 'fold'; stub: string };

export function buildSweepPrompt(candidates: readonly Candidate[], aggressive: boolean): string {
  const head = [
    'You are the librarian of a coding session. Each <candidate> below is a stale tool result',
    'still occupying the live context. For each one decide:',
    '  keep — its exact content is likely needed verbatim again soon;',
    '  fold — a short stub suffices; full content stays recoverable on demand.',
    aggressive ? 'The working set is over budget: fold everything not clearly needed.' : '',
    'For EVERY candidate answer exactly one line:',
    '<decision id="ID" action="keep|fold">one-to-three-line stub: what it is, what it contains, what one would ask for</decision>',
    'Write the stub from the content you see. No other output.',
  ].filter(Boolean).join('\n');
  const body = candidates.map(c =>
    `<candidate id="${c.toolUseId}" tool="${c.tool}" input=${JSON.stringify(JSON.stringify(c.input))} age_turns="${c.ageTurns}">\n${c.text}\n</candidate>`
  ).join('\n');
  return `${head}\n\n${body}`;
}

export function parseSweepReply(reply: string, expectedIds: readonly string[]): LibrarianDecision[] {
  const re = /<decision id="([^"]+)" action="(keep|fold)">([\s\S]*?)<\/decision>/g;
  const found = new Map<string, LibrarianDecision>();
  for (let m = re.exec(reply); m !== null; m = re.exec(reply)) {
    found.set(m[1], { toolUseId: m[1], action: m[2] as 'keep' | 'fold', stub: m[3].trim() });
  }
  for (const id of expectedIds) if (!found.has(id)) throw new Error(`librarian reply missing decision for ${id}`);
  for (const id of found.keys()) if (!expectedIds.includes(id)) throw new Error(`librarian reply names unknown id ${id}`);
  return expectedIds.map(id => found.get(id)!);
}

export async function runLibrarian(
  $: EngineInterface, model: string, candidates: readonly Candidate[], aggressive: boolean,
): Promise<{ decisions: LibrarianDecision[]; inputTokens: number; outputTokens: number }> {
  const prompt = buildSweepPrompt(candidates, aggressive);
  const reply = String(await $.model.complete({ model, prompt, maxTokens: 4096 }));
  const decisions = parseSweepReply(reply, candidates.map(c => c.toolUseId));
  return { decisions, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(reply) };
}
```

(`$.model.complete` resolves to the reply's text per the declarations' example `const reply = await $.model.complete({ model: "haiku", prompt: "Hi." })`; if it resolves to an object, take its text field — check the `ModelCompleteReply` type in the generated file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/librarian.ts tests/librarian.test.ts
git commit -m "feat: librarian prompt/parse with full-content invariant"
```

---

### Task 6: origami.ts — session.compact interceptor

**Files:**
- Modify: `hooks/origami.ts`
- Test: `tests/interceptor.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: `runSweep($, cfg, e): Promise<SessionCompactResult>` exported for testing; `register` wires `on('session.compact', ...)`.

- [ ] **Step 1: Write failing tests**

`tests/interceptor.test.ts`:
```ts
import { test, expect, mock } from 'claude-code/testing';
import { runSweep } from '../hooks/origami';
import { readConfig } from '../hooks/origami';
import { getFold } from '../hooks/store';
import type { SessionMessage } from 'claude-code';

const cfg = readConfig(undefined);

function transcript(): SessionMessage[] {
  const out: SessionMessage[] = [{ role: 'user', text: 'turn0', toolUses: [], handle: 'h0' }];
  out.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } }], handle: 'h1' });
  out.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'CONTENT '.repeat(2000), isError: false }], handle: 'h2' });
  for (let i = 1; i <= 4; i++) {
    out.push({ role: 'user', text: `turn${i}`, toolUses: [], handle: `hu${i}` });
    out.push({ role: 'assistant', text: `r${i}`, toolUses: [], handle: `ha${i}` });
  }
  return out;
}

test('sweep folds the stale result, persists the fold, logs the sweep', async ($) => {
  mock.model?.complete?.(() => `<decision id="t1" action="fold">Read a.ts — repeated CONTENT block.</decision>`);
  const r = await runSweep($, cfg, { trigger: 'plugin', messages: transcript() });
  if (!('messages' in r) || !r.messages) throw new Error(`expected messages, got ${JSON.stringify(r)}`);
  expect(r.messages[2].toolResults![0].text.includes('fold-001')).toBe(true);
  const stored = await getFold($, 'fold-001');
  expect(stored!.body.includes('CONTENT')).toBe(true);
  const log = String(await $.fs.read('.claude/origami/origami.log'));
  expect(log.includes('"event":"sweep"')).toBe(true);
  expect(log.includes('librarianInputTokens')).toBe(true);
});

test('subagent compaction passes through untouched', async ($) => {
  const r = await runSweep($, cfg, { trigger: 'plugin', agentId: 'sub-1', messages: transcript() });
  expect(r).toBe(undefined); // undefined = caller must next(e)
});

test('librarian failure on plugin trigger yields skip; on manual yields pass-through', async ($) => {
  mock.model?.complete?.(() => { throw new Error('model down'); });
  const plugin = await runSweep($, cfg, { trigger: 'plugin', messages: transcript() });
  expect((plugin as { skip?: string })?.skip !== undefined).toBe(true);
  const manual = await runSweep($, cfg, { trigger: 'manual', messages: transcript() });
  expect(manual).toBe(undefined); // fall through to built-in compaction
});
```

(`mock.model.complete` spelling is the kit's to define — the declarations' testing section documents `mock`, "whose clock, store and env answer those nouns"; adapt the stubbing mechanics to what the kit exposes, keeping the asserted outcomes. If the kit cannot stub `$.model`, split `runSweep` so tests inject a `librarian` function directly: `runSweep($, cfg, e, librarianFn)` with the production default.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: FAIL — `runSweep` not exported.

- [ ] **Step 3: Implement (in `hooks/origami.ts`)**

```ts
import type { Register, EngineInterface, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code';
import { selectCandidates, rebuild, estimateTokens, type FoldDecision, type RestoreDecision } from './rebuild';
import { runLibrarian } from './librarian';
import { newFoldId, putFold, getFold, setFold, allFolds, appendLog, type FoldEntry } from './store';

// returns a result to answer with, or undefined = caller must pass through via next(e)
export async function runSweep(
  $: EngineInterface, cfg: OrigamiConfig, e: Pick<SessionCompactInput, 'trigger' | 'agentId' | 'messages'>,
): Promise<SessionCompactResult | undefined> {
  if (e.agentId) return undefined;                       // main thread only
  if (e.trigger === 'precompute') return undefined;      // out of scope v1
  try {
    const folds = await allFolds($);
    // pinned folds stay open: once restored inline their big results must never
    // become candidates again, so exclusion is by the toolUseId the entry recorded
    const excluded = new Set(folds.filter(f => f.state === 'pinned').map(f => f.toolUseId));
    const aggressive = Boolean(await $.store.get('origami:aggressive'));
    const candidates = selectCandidates(e.messages, excluded, cfg, aggressive)
      .filter(c => !c.text.startsWith('[origami fold-'));  // never re-fold a stub
    // reopen pinned folds whose stubs still sit in history
    const restores: RestoreDecision[] = [];
    for (const f of folds.filter(f => f.state === 'pinned')) {
      for (const m of e.messages) {
        for (const r of m.toolResults ?? []) {
          if (r.text.includes(`[origami ${f.id} `)) {
            const stored = await getFold($, f.id);
            if (stored) restores.push({ toolUseId: r.tool_use_id, foldId: f.id, body: stored.body });
          }
        }
      }
    }
    if (candidates.length === 0 && restores.length === 0) {
      return e.trigger === 'plugin' ? { skip: 'origami: nothing to fold' } : undefined;
    }
    const lib = candidates.length > 0
      ? await runLibrarian($, cfg.librarianModel, candidates, aggressive)
      : { decisions: [], inputTokens: 0, outputTokens: 0 };
    const foldDecisions: FoldDecision[] = [];
    for (const d of lib.decisions) {
      if (d.action !== 'fold') continue;
      const c = candidates.find(x => x.toolUseId === d.toolUseId)!;
      const id = await newFoldId($);
      const entry: FoldEntry = { id, stub: d.stub, state: 'folded', tool: c.tool, toolUseId: c.toolUseId, originAge: c.ageTurns, sizeTokens: c.sizeTokens, hydrations: 0 };
      await putFold($, entry, `# ${id} · ${c.tool} ${JSON.stringify(c.input)}\n\n${c.text}`);
      foldDecisions.push({ toolUseId: d.toolUseId, foldId: id, stub: d.stub });
    }
    const outcome = rebuild(e.messages, foldDecisions, restores, cfg, aggressive);
    if (outcome.kind === 'insufficient') {
      return e.trigger === 'plugin' ? { skip: `origami: reduction ${outcome.ratio.toFixed(2)} below threshold` } : undefined;
    }
    await $.store.set('origami:aggressive', false);
    await appendLog($, {
      event: 'sweep', trigger: e.trigger, aggressive,
      tokensBefore: outcome.tokensBefore, tokensAfter: outcome.tokensAfter,
      librarianInputTokens: lib.inputTokens, librarianOutputTokens: lib.outputTokens,
      foldsCreated: foldDecisions.length, restores: restores.length,
    });
    return { messages: outcome.messages, tokensBefore: outcome.tokensBefore, tokensAfter: outcome.tokensAfter };
  } catch (err) {
    $.ui.log(`origami sweep failed, falling back: ${err instanceof Error ? err.message : String(err)}`);
    return e.trigger === 'plugin' ? { skip: 'origami: sweep failed' } : undefined;
  }
}
```

And in `register`:
```ts
export const register: Register = (on, options) => {
  const config = readConfig(options);
  on('session.compact', async ($, e, next) => {
    const result = await runSweep($, config, e);
    return result ?? next(e);
  });
};
```

(Already-folded stubs are doubly protected: the explicit `[origami fold-` filter and the `MIN_CANDIDATE_TOKENS` size gate.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/origami.ts tests/interceptor.test.ts
git commit -m "feat: session.compact interceptor with fallback-to-stock on every failure"
```

---

### Task 7: origami.ts — turn.complete trigger

**Files:**
- Modify: `hooks/origami.ts`
- Test: `tests/trigger.test.ts`

**Interfaces:**
- Consumes: `selectCandidates`, `candidateMass` (Task 2); `$.session.usage()`, `$.session.messages()`, `$.session.compact()`.
- Produces: `shouldSweep($, cfg): Promise<{ sweep: boolean; aggressive: boolean }>` exported for testing; `register` wires `on('turn.complete', ...)`.

- [ ] **Step 1: Write failing tests**

`tests/trigger.test.ts`:
```ts
import { test, expect, mock } from 'claude-code/testing';
import { shouldSweep, readConfig } from '../hooks/origami';
import type { SessionMessage } from 'claude-code';

const cfg = readConfig(undefined);

function heavyTranscript(resultChars: number): SessionMessage[] {
  const out: SessionMessage[] = [{ role: 'user', text: 'turn0', toolUses: [] }];
  out.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: {} }] });
  out.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'x'.repeat(resultChars), isError: false }] });
  for (let i = 1; i <= 4; i++) {
    out.push({ role: 'user', text: `turn${i}`, toolUses: [] });
    out.push({ role: 'assistant', text: `r${i}`, toolUses: [] });
  }
  return out;
}

test('mass below threshold: no sweep', async ($) => {
  mock.session?.messages?.(() => heavyTranscript(8000));   // ~2k tokens < 20k
  const d = await shouldSweep($, cfg);
  expect(d.sweep).toBe(false);
});

test('mass above threshold: sweep', async ($) => {
  mock.session?.messages?.(() => heavyTranscript(100000)); // ~25k tokens
  const d = await shouldSweep($, cfg);
  expect(d.sweep).toBe(true);
  expect(d.aggressive).toBe(false);
});

test('working set over budget: aggressive', async ($) => {
  mock.session?.messages?.(() => heavyTranscript(500000)); // ~125k > 100k budget
  const d = await shouldSweep($, cfg);
  expect(d.aggressive).toBe(true);
});
```

(As in Task 6: if the kit stubs `$.session.messages` differently — or not at all — inject the transcript: `shouldSweep($, cfg, messages?)` with production default `await $.session.messages()`. Keep the asserted outcomes.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: FAIL — `shouldSweep` not exported.

- [ ] **Step 3: Implement (in `hooks/origami.ts`)**

```ts
import { candidateMass } from './rebuild';   // merge into the existing import from './rebuild'

export async function shouldSweep(
  $: EngineInterface, cfg: OrigamiConfig, messagesArg?: readonly SessionMessage[],
): Promise<{ sweep: boolean; aggressive: boolean }> {
  const messages = messagesArg ?? await $.session.messages();
  const liveTokens = messages.reduce((s, m) => s + estimateTokens(m.text)
    + (m.toolResults ?? []).reduce((a, r) => a + estimateTokens(r.text), 0), 0);
  const aggressive = liveTokens > cfg.workingSetBudget;
  const mass = candidateMass(
    selectCandidates(messages, new Set<string>(), cfg, aggressive)
      .filter(c => !c.text.startsWith('[origami fold-')),
  );
  return { sweep: mass >= cfg.minFoldMass || (aggressive && mass > 0), aggressive };
}
```

In `register`, add (with the in-flight guard):
```ts
let sweeping = false;
on('turn.complete', async ($, e, next) => {
  if ((e as { agentId?: string }).agentId) return next(e);   // main thread only
  if (!sweeping) {
    try {
      const d = await shouldSweep($, config);
      if (d.sweep) {
        sweeping = true;
        await $.store.set('origami:aggressive', d.aggressive);
        await $.session.compact();          // rejects while a turn runs → caught below
      }
    } catch (err) {
      $.ui.log(`origami trigger skipped: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      sweeping = false;
    }
  }
  return next(e);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/origami.ts tests/trigger.test.ts
git commit -m "feat: mass-based sweep trigger with workingSetBudget backstop"
```

---

### Task 8: hydrate and unpin tools

**Files:**
- Modify: `hooks/origami.ts`
- Test: `tests/tools.test.ts`

**Interfaces:**
- Consumes: `getFold`, `setFold`, `appendLog` (Task 4); `$.tool.register`; `on('tool.call', { tool }, ...)`.
- Produces: `handleHydrate($, cfg, foldId): Promise<string>`, `handleUnpin($, foldId): Promise<string>` exported for testing; `register` registers both tools on `session.start` and serves them via `tool.call` hooks.

- [ ] **Step 1: Write failing tests**

`tests/tools.test.ts`:
```ts
import { test, expect } from 'claude-code/testing';
import { handleHydrate, handleUnpin, readConfig } from '../hooks/origami';
import { putFold, getFold } from '../hooks/store';

const cfg = readConfig(undefined);
const entry = { id: 'fold-001', stub: 's', state: 'folded' as const, tool: 'Read', toolUseId: 'tA', originAge: 3, sizeTokens: 2000, hydrations: 0 };

test('hydrate returns body, counts, pins at threshold, logs', async ($) => {
  await putFold($, entry, 'THE FULL BODY');
  const first = await handleHydrate($, cfg, 'fold-001');
  expect(first.includes('THE FULL BODY')).toBe(true);
  expect((await getFold($, 'fold-001'))!.entry.hydrations).toBe(1);
  const second = await handleHydrate($, cfg, 'fold-001');
  expect(second.includes('pinned')).toBe(true);               // tells the model it is now pinned
  expect((await getFold($, 'fold-001'))!.entry.state).toBe('pinned');
  const log = String(await $.fs.read('.claude/origami/origami.log'));
  expect(log.split('\n').filter(l => l.includes('"event":"hydrate"')).length).toBe(2);
});

test('unpin resets state and count, logs', async ($) => {
  await putFold($, { ...entry, state: 'pinned', hydrations: 2 }, 'B');
  const r = await handleUnpin($, 'fold-001');
  expect(r.includes('fold-001')).toBe(true);
  const got = (await getFold($, 'fold-001'))!.entry;
  expect(got.state).toBe('folded');
  expect(got.hydrations).toBe(0);
});

test('unknown ids return instructive errors, never throw', async ($) => {
  const h = await handleHydrate($, cfg, 'fold-999');
  expect(h.includes('fold-999')).toBe(true);
  expect(h.toLowerCase().includes('unknown')).toBe(true);
  const u = await handleUnpin($, 'nonsense');
  expect(u.toLowerCase().includes('unknown')).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: FAIL — handlers not exported.

- [ ] **Step 3: Implement (in `hooks/origami.ts`)**

```ts
export async function handleHydrate($: EngineInterface, cfg: OrigamiConfig, foldId: string): Promise<string> {
  const found = await getFold($, foldId);
  if (!found) return `Unknown fold id "${foldId}". Fold ids look like fold-001 and appear in [origami fold-…] stubs in the conversation.`;
  const hydrations = found.entry.hydrations + 1;
  const pinned = hydrations >= cfg.pinAfterHydrations && found.entry.state !== 'pinned';
  await setFold($, { ...found.entry, hydrations, state: pinned ? 'pinned' : found.entry.state });
  await appendLog($, { event: 'hydrate', foldId, hydrations, originAge: found.entry.originAge });
  const note = pinned
    ? `\n\n[origami: ${foldId} has now been hydrated ${hydrations}× and is pinned — it will be restored inline and stay open. Call unpin("${foldId}") if that stops being useful.]`
    : '';
  return found.body + note;
}

export async function handleUnpin($: EngineInterface, foldId: string): Promise<string> {
  const found = await getFold($, foldId);
  if (!found) return `Unknown fold id "${foldId}".`;
  await setFold($, { ...found.entry, state: 'folded', hydrations: 0 });
  await appendLog($, { event: 'unpin', foldId });
  return `${foldId} unpinned: it is fold-eligible again and will refold on the next sweep.`;
}
```

In `register`, add:
```ts
on('session.start', async ($, e, next) => {
  await $.tool.register({
    name: 'hydrate',
    description: 'Expand an origami fold to its full stored content. Use before re-running a tool whose result was folded — re-running may not reproduce it (files change, tests flake). fold_id appears in [origami fold-…] stubs.',
    inputSchema: { type: 'object', properties: { fold_id: { type: 'string' } }, required: ['fold_id'] },
  });
  await $.tool.register({
    name: 'unpin',
    description: 'Release a pinned origami fold so it can fold again. Use when pinned content is no longer earning its place in context.',
    inputSchema: { type: 'object', properties: { fold_id: { type: 'string' } }, required: ['fold_id'] },
  });
  return next(e);
});
on('tool.call', { tool: 'mcp__origami__hydrate' }, async ($, e) => {
  return { text: await handleHydrate($, config, String((e as { fold_id?: unknown }).fold_id ?? '')) };
});
on('tool.call', { tool: 'mcp__origami__unpin' }, async ($, e) => {
  return { text: await handleUnpin($, String((e as { fold_id?: unknown }).fold_id ?? '')) };
});
```

(The exact `tool.call` result envelope — `{ text }` vs a richer shape — and where the tool's input lands on `e` are defined in the generated declarations' `ToolCallInput`/`ToolCallResult`; adapt the two thin handlers, not the exported logic.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: PASS (full suite).

- [ ] **Step 5: Commit**

```bash
git add hooks/origami.ts tests/tools.test.ts
git commit -m "feat: hydrate/unpin tools with hysteresis pinning and event log"
```

---

### Task 9: Skill and README rewrite

**Files:**
- Modify: `skills/context-folding/SKILL.md` (full rewrite)
- Modify: `README.md` (full rewrite)

**Interfaces:**
- Consumes: tool names `hydrate`/`unpin` (`mcp__origami__hydrate`, `mcp__origami__unpin`), stub format `[origami fold-NNN · <tool> result folded] …` from Task 3.

- [ ] **Step 1: Rewrite the skill**

`skills/context-folding/SKILL.md`:
```markdown
---
name: context-folding
description: Use when the conversation contains [origami fold-…] stubs, when you need detail that was folded, or when deciding whether to re-run a tool whose earlier result may have been folded.
---

# Living with folded context

This session runs Origami: bulky stale tool results are folded to disk and
replaced with stubs like:

    [origami fold-012 · Read result folded] src/auth.ts (480 lines) — JWT
    validation, refresh flow, SECRET_ROTATION constant. — call
    hydrate("fold-012") for the full content.

A stub means you once knew this in full and can know it again instantly.

## Rules

1. **Hydrate before re-running.** If a stub covers what you need, call
   `hydrate(fold_id)` instead of re-running the tool. A re-read is not
   idempotent: files change, tests flake, command output drifts. The fold is
   the exact bytes you saw.
2. **Hydrated content may fold again** after a few turns. That is normal; the
   stub returns and hydrate still works.
3. **Repeated need pins automatically.** The second hydrate of the same fold
   pins it open: it is restored inline and stops folding.
4. **Unpin what stops earning its place.** If pinned content is no longer
   relevant, call `unpin(fold_id)` so the context stays lean.
5. Do not quote a stub as if it were the content. If the stub is not enough
   to answer precisely, hydrate first.
```

- [ ] **Step 2: Rewrite the README**

`README.md` — keep the name and one-paragraph concept from v0's intro, then document (all content available in the spec — do not invent): How It Works (the Flow diagram from the spec), Installation (Claude Code >= 2.1.259, `export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, `claude plugin marketplace add dullfig/origami`, `claude plugin install origami@origami` — verify exact marketplace syntax against fast-jev's README), Configuration (the userConfig table from the spec), Tools (`hydrate`, `unpin`), Data storage (`.claude/origami/`), **Coexistence with classic hooks** (the PostCompact gating guidance from the spec's Coexistence section, updated with the trigger value actually observed in Task 10), Early-access caveat (pin the Claude Code version that generated `types/claude-code.d.ts`; regenerate with `/plugin-types` after upgrades), License MIT.

- [ ] **Step 3: Run full test suite (nothing should break)**

Run: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add skills/context-folding/SKILL.md README.md
git commit -m "docs: rewrite skill and README for the function-hooks architecture"
```

---

### Task 10: Manual smoke test and findings

**Files:**
- Create: `docs/superpowers/specs/2026-09-19-smoke-findings.md`
- Modify: `README.md` (Coexistence section, with observed values)

This task is interactive — run it WITH the user in a real session.

- [ ] **Step 1: Install and launch**

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
claude --plugin-dir C:\src\origami
```

- [ ] **Step 2: Exercise the fold cycle**

In the session: ask Claude to Read 4–5 large files (>30k chars total), then chat for 4+ turns without touching them. Verify, in order:
1. A sweep fires (toast/log) without any manual `/compact`.
2. Old Read results now show `[origami fold-…]` stubs; recent turns untouched; user/assistant text verbatim.
3. Ask a question needing folded detail → model calls `hydrate` → answer is correct and cites real content.
4. Hydrate the same fold again (ask another detail question) → pin notice appears; next sweep restores it inline.
5. Call `unpin` on it (ask the model to) → next sweep refolds it.
6. `.claude/origami/origami.log` holds sweep records with `librarianInputTokens` and hydrate/unpin records.

- [ ] **Step 3: Coexistence and scope checks**

1. With a classic PostCompact hook configured (any command that writes its input JSON to a file), trigger an origami sweep and record the `trigger` value classic hooks receive. Expected `plugin`; whatever is observed goes verbatim into README's Coexistence section. If sweeps are NOT distinguishable from stock compaction there, note it as a finding to post on anthropics/claude-code#91870.
2. Spawn a subagent (any Task/Agent call) mid-session; verify no fold stubs ever appear in its transcript and no sweep fires on its `turn.complete`.

- [ ] **Step 4: Record findings**

Write `docs/superpowers/specs/2026-09-19-smoke-findings.md`: what fired when, observed trigger values, stub quality (verbatim examples), token reductions from the log, anything surprising. Update README Coexistence with observed values.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-19-smoke-findings.md README.md
git commit -m "test: record smoke findings; document observed PostCompact trigger"
```
