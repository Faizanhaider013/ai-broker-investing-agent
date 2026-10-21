import { describe, expect, it } from 'vitest';
import { chainName, explorerAddressUrl, shortenAddress, summarizeWallets } from '../wallet';
import { toolConfigMap } from '../mcp/tools-config.js';
import { EthereumMCPClient } from '../mcp-client';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

describe('summarizeWallets', () => {
  it('returns null when the user has no wallet', () => {
    expect(summarizeWallets([])).toBeNull();
  });

  it('picks the wallet flagged primary', () => {
    const info = summarizeWallets([
      { address: A, chainId: 1, isPrimary: false },
      { address: B, chainId: 137, isPrimary: true },
    ]);
    expect(info?.address).toBe(B);
    expect(info?.chainId).toBe(137);
    expect(info?.wallets).toHaveLength(2);
  });

  it('falls back to the first wallet and normalizes a null isPrimary', () => {
    const info = summarizeWallets([{ address: A, chainId: 1, isPrimary: null }]);
    expect(info).toEqual({ address: A, chainId: 1, wallets: [{ address: A, chainId: 1, isPrimary: false }] });
  });
});

describe('display helpers', () => {
  it('names known and unknown chains', () => {
    expect(chainName(8453)).toBe('Base');
    expect(chainName(999)).toBe('Chain 999');
  });

  it('shortens addresses', () => {
    expect(shortenAddress(A)).toBe('0x1111...1111');
    expect(shortenAddress('0x12')).toBe('0x12');
  });

  it('links to the chain explorer, defaulting to Etherscan', () => {
    expect(explorerAddressUrl(A, 137)).toBe(`https://polygonscan.com/address/${A}`);
    expect(explorerAddressUrl(A, 999)).toBe(`https://etherscan.io/address/${A}`);
  });
});

describe('EthereumMCPClient', () => {
  it('exposes the MCP tool configs', () => {
    const client = new EthereumMCPClient();
    expect(client.getAvailableTools()).toContain('ethGetBalance');
    expect(toolConfigMap.get('jsonRpc')?.pathTemplate).toBe('/jsonrpc');
  });

  it('reports an unknown tool without making a request', async () => {
    const result = await new EthereumMCPClient().callTool('nope');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});
