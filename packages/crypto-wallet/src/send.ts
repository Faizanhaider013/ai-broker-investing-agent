/**
 * Validation for the "send ETH" form. Framework-free so it can be tested and
 * reused by any wallet UI (Privy embedded wallet, injected wallet, ...).
 */
import { isAddress, parseEther } from 'viem';

export type SendRequest = { to: `0x${string}`; value: bigint };

export type SendValidation = { ok: true; request: SendRequest } | { ok: false; error: string };

/**
 * Turn the raw form inputs into a native-asset transfer. `amount` is in ETH
 * (or the chain's native asset); the result's `value` is in wei.
 * Refuses a zero or negative amount, malformed numbers, a bad recipient, and
 * sending to yourself.
 */
export function validateSend(to: string, amount: string, from?: string): SendValidation {
  const recipient = to.trim();
  if (!isAddress(recipient)) {
    return { ok: false, error: 'Enter a valid 0x recipient address.' };
  }
  if (from && recipient.toLowerCase() === from.toLowerCase()) {
    return { ok: false, error: 'That is your own wallet address.' };
  }
  const trimmed = amount.trim();
  if (!/^\d*\.?\d+$/.test(trimmed)) {
    return { ok: false, error: 'Enter an amount like 0.01.' };
  }
  let value: bigint;
  try {
    value = parseEther(trimmed);
  } catch {
    return { ok: false, error: 'Enter an amount like 0.01.' };
  }
  if (value <= 0n) {
    return { ok: false, error: 'The amount must be more than zero.' };
  }
  return { ok: true, request: { to: recipient, value } };
}

/** `eip155:8453` or `8453` -> 8453; anything else -> undefined. */
export function parseChainId(chainId: string | number | undefined): number | undefined {
  if (typeof chainId === 'number') return chainId;
  if (!chainId) return undefined;
  const n = Number(chainId.split(':').pop());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
