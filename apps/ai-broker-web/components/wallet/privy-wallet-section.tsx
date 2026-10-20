"use client"

import { PrivyWalletProvider, EmbeddedWallet } from "crypto-wallet/privy"

/**
 * Loaded lazily from the Crypto Wallet page so Privy's SDK only ships to
 * visitors who open that page and only when an App ID is configured.
 */
export default function PrivyWalletSection({ appId, clientId }: { appId: string; clientId?: string }) {
  return (
    <PrivyWalletProvider appId={appId} clientId={clientId}>
      <EmbeddedWallet />
    </PrivyWalletProvider>
  )
}
