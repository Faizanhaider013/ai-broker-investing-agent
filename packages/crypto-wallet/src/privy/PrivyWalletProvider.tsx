'use client';

import { PrivyProvider } from '@privy-io/react-auth';

export interface PrivyWalletProviderProps {
  /** Privy App ID from the Privy dashboard. */
  appId: string;
  /** Optional Privy App Client ID, for per-environment client settings. */
  clientId?: string;
  children: React.ReactNode;
}

/**
 * Privy context for the embedded wallet. Users without a wallet get an
 * Ethereum embedded wallet created on login; login methods and allowed
 * origins are whatever the Privy dashboard has enabled for the app.
 */
export function PrivyWalletProvider({ appId, clientId, children }: PrivyWalletProviderProps) {
  return (
    <PrivyProvider
      appId={appId}
      clientId={clientId}
      config={{
        embeddedWallets: {
          ethereum: { createOnLogin: 'users-without-wallets' },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
