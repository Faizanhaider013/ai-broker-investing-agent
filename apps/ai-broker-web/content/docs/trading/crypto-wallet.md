---
title: Crypto Wallet
description: "Link an Ethereum wallet to your account and see it from the sidebar."
icon: Wallet
---

The **Crypto Wallet** page (sidebar, under *Risk & Portfolio*) gives you two
ways to hold crypto: an in-app wallet that needs nothing installed, and your
own wallet such as MetaMask.

## In-app wallet

1. Open **Crypto Wallet** and choose **Create or open wallet**.
2. Log in with email or a social account. A wallet is created for you the
   first time.
3. The card shows your address (with a block-explorer link) and your balance.

**Send**: enter a recipient `0x…` address and an amount in ETH, then confirm
in the pop-up. This sends the network's native asset (ETH), not tokens such as
USDC, and the network charges a gas fee. Transactions cannot be reversed, so
check the address.

**Export private key** lets you move the wallet to MetaMask or another app.
Anyone with the key controls the funds; never share it.

## Your own wallet (MetaMask)

1. Install MetaMask or another browser wallet that injects `window.ethereum`.
2. Under **Your own wallet**, choose **Sign in with Ethereum**.
3. Approve the connection and sign the Sign-In with Ethereum (SIWE) message.
   Signing proves you own the address; it does not send a transaction or cost gas.

The page then lists your linked wallets: the primary address (★), its network
(Ethereum Mainnet, Polygon, Optimism, Arbitrum One, Base, or Sepolia), and a
block-explorer link.

## For operators

The in-app wallet uses [Privy](https://www.privy.io). Create an app in the
Privy dashboard, add this site's domain to its allowed origins, and set
`PRIVY_APP_ID` (optionally `PRIVY_CLIENT_ID`) as a Worker variable. It is read
at request time, so no rebuild is needed. Until it is set the page says the
in-app wallet isn't set up.

## For developers

The wallet ships as the `crypto-wallet` workspace package (ported from
[crypto-wallet-ai](https://github.com/vtempest/crypto-wallet-ai)). Besides the
UI it provides wallet-aware LangChain tools for agents (`getWalletAwareTools`)
and a client for the Ethereum MCP server. See
[Workspace Packages](/docs/reference/packages#crypto-wallet).
