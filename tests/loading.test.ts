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
