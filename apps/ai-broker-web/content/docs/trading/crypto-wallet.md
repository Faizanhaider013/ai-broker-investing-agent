---
title: Crypto Wallet
description: "Link an Ethereum wallet to your account and see it from the sidebar."
icon: Wallet
---

The **Crypto Wallet** page (sidebar, under *Risk & Portfolio*) shows the
Ethereum wallets linked to your account.

## Connect a wallet

1. Install MetaMask or another browser wallet that injects `window.ethereum`.
2. Open **Crypto Wallet** and choose **Sign in with Ethereum**.
3. Approve the connection and sign the Sign-In with Ethereum (SIWE) message.
   Signing proves you own the address; it does not send a transaction or cost gas.

The wallet's address and network are saved to your account.

## What the page shows

- **Primary address**, shortened, with a link to the network's block explorer.
- **Network**: Ethereum Mainnet, Polygon, Optimism, Arbitrum One, Base, or Sepolia.
- **All wallets**, when more than one is linked, with the primary marked ★.

The data comes from `GET /api/wallet/info`, which answers `401` when you are
signed out and `404` when no wallet is linked.

## For developers

The wallet ships as the `crypto-wallet` workspace package (ported from
[crypto-wallet-ai](https://github.com/vtempest/crypto-wallet-ai)). Besides the
UI it provides wallet-aware LangChain tools for agents (`getWalletAwareTools`)
and a client for the Ethereum MCP server. See
[Workspace Packages](/docs/reference/packages#crypto-wallet).
