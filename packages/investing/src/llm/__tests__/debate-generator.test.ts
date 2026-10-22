import { describe, expect, it, vi } from 'vitest';
import { validateDebateAnalysis } from '../debate-generator';

const base = {
  yesArguments: ['a'],
  noArguments: ['b'],
  yesSummary: 'yes',
  noSummary: 'no',
  keyFactors: ['k'],
  uncertainties: ['u'],
};

describe('validateDebateAnalysis', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});

  it('accepts a response with no model probabilities', () => {
    expect(validateDebateAnalysis(base)).toEqual(base);
  });

  it('accepts probabilities in range that add up to 1', () => {
    const ok = { ...base, modelYesProbability: 0.63, modelNoProbability: 0.37 };
    expect(validateDebateAnalysis(ok)).toEqual(ok);
  });

  it('still rejects a missing required field', () => {
    expect(() => validateDebateAnalysis({ ...base, yesSummary: '' })).toThrow(/yesSummary/);
  });

  it('rejects a probability outside 0..1', () => {
    expect(() =>
      validateDebateAnalysis({ ...base, modelYesProbability: 63, modelNoProbability: 0.37 })
    ).toThrow(/between 0 and 1/);
  });

  it('rejects a probability that is not a number', () => {
    expect(() =>
      validateDebateAnalysis({ ...base, modelYesProbability: '0.6', modelNoProbability: 0.4 })
    ).toThrow(/between 0 and 1/);
  });

  it('rejects yes and no that do not add up to about 1', () => {
    expect(() =>
      validateDebateAnalysis({ ...base, modelYesProbability: 0.7, modelNoProbability: 0.7 })
    ).toThrow(/about 1/);
  });
});
