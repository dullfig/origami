import { test, expect } from 'claude-code/testing';
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
  const d = await shouldSweep($, cfg, heavyTranscript(8000));   // ~2k tokens < 20k
  expect(d.sweep).toBe(false);
});

test('mass above threshold: sweep', async ($) => {
  const d = await shouldSweep($, cfg, heavyTranscript(100000)); // ~25k tokens
  expect(d.sweep).toBe(true);
  expect(d.aggressive).toBe(false);
});

test('working set over budget: aggressive', async ($) => {
  const d = await shouldSweep($, cfg, heavyTranscript(500000)); // ~125k > 100k budget
  expect(d.aggressive).toBe(true);
});
