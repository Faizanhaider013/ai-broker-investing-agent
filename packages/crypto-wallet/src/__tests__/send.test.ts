import { describe, expect, it } from 'vitest';
import { parseChainId, validateSend } from '../send';

const ME = '0x1111111111111111111111111111111111111111';
const YOU = '0x2222222222222222222222222222222222222222';

describe('validateSend', () => {
  it('converts an ETH amount to wei', () => {
    expect(validateSend(` ${YOU} `, '0.001', ME)).toEqual({
      ok: true,
      request: { to: YOU, value: 1_000_000_000_000_000n },
    });
  });

  it('rejects a malformed recipient', () => {
    expect(validateSend('0x123', '1').ok).toBe(false);
  });

  it('rejects sending to yourself, case-insensitively', () => {
    const result = validateSend(ME, '1', ME.toUpperCase().replace('0X', '0x'));
    expect(result).toEqual({ ok: false, error: 'That is your own wallet address.' });
  });

  it.each(['', '0', '0.0', '-1', 'abc', '1e18', '1.2.3'])('rejects amount %j', (amount) => {
    expect(validateSend(YOU, amount).ok).toBe(false);
  });
});

describe('parseChainId', () => {
  it('reads CAIP-2 and bare ids', () => {
    expect(parseChainId('eip155:8453')).toBe(8453);
    expect(parseChainId('137')).toBe(137);
    expect(parseChainId(10)).toBe(10);
  });

  it('returns undefined for junk', () => {
    expect(parseChainId(undefined)).toBeUndefined();
    expect(parseChainId('eip155:abc')).toBeUndefined();
  });
});
