/**
 * Framework-free wallet helpers shared by the UI components and the API.
 *
 * Nothing here imports viem or LangChain, so client components can use it
 * without pulling the RPC tooling into the browser bundle.
 */

/** Display names for the chains the wallet knows about. */
export const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum Mainnet',
  137: 'Polygon',
  10: 'Optimism',
  42161: 'Arbitrum One',
  8453: 'Base',
  5: 'Goerli Testnet',
  11155111: 'Sepolia Testnet',
};

/** Block explorer base URL per chain; unknown chains fall back to Etherscan. */
const EXPLORERS: Record<number, string> = {
  1: 'https://etherscan.io',
  137: 'https://polygonscan.com',
  10: 'https://optimistic.etherscan.io',
  42161: 'https://arbiscan.io',
  8453: 'https://basescan.org',
  11155111: 'https://sepolia.etherscan.io',
};

export function chainName(chainId: number): string {
  return CHAIN_NAMES[chainId] || `Chain ${chainId}`;
}

export function explorerAddressUrl(address: string, chainId = 1): string {
  return `${EXPLORERS[chainId] || EXPLORERS[1]}/address/${address}`;
}

/** `0x1234...abcd` */
export function shortenAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** A wallet row as stored by the SIWE plugin (`wallet_addresses`). */
export interface WalletRecord {
  address: string;
  chainId: number;
  isPrimary: boolean | null;
}

/** The shape returned by `GET /api/wallet/info` and read by `<WalletInfo />`. */
export interface WalletInfoData {
  address: string;
  chainId: number;
  wallets: Array<{
    address: string;
    chainId: number;
    isPrimary: boolean;
  }>;
}

/**
 * Collapse a user's wallet rows into the API response: the primary wallet
 * (or the first one when none is flagged) plus the full list. Returns null
 * when the user has no linked wallet.
 */
export function summarizeWallets(wallets: readonly WalletRecord[]): WalletInfoData | null {
  if (wallets.length === 0) return null;
  const primary = wallets.find((w) => w.isPrimary) || wallets[0];
  return {
    address: primary.address,
    chainId: primary.chainId,
    wallets: wallets.map((w) => ({
      address: w.address,
      chainId: w.chainId,
      isPrimary: Boolean(w.isPrimary),
    })),
  };
}
