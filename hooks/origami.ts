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
