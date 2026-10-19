# crypto-wallet

The crypto wallet from [vtempest/crypto-wallet-ai](https://github.com/vtempest/crypto-wallet-ai),
packaged for the AI Broker monorepo: its wallet UI component, its Ethereum API
(wallet-aware LangChain tools, generic Ethereum query tools, the Ethereum MCP
client) and all of its documentation.

In the app it powers the **Crypto Wallet** sidebar page (`/wallet`), which
offers two wallets:

- **In-app wallet** ([Privy](https://docs.privy.io) embedded wallet): log in
  with email or a social account, get an Ethereum wallet created for you, see
  its address and balance, send the native asset, and export the key. Needs
  `PRIVY_APP_ID` (read at request time through `GET /api/wallet/config`).
- **Your own wallet**: MetaMask or any injected wallet, linked through the
  app's existing Sign-In with Ethereum (better-auth `siwe` plugin, table
  `wallet_addresses`) and listed by `GET /api/wallet/info`.

## Entry points

| Import | What | Runs on |
| --- | --- | --- |
| `crypto-wallet` | Everything below plus `getWalletAwareTools`, `generateEthereumTools` / `generateCommonEthereumTools` / `generateWalletTools` / `generateBlockchainQueryTools`, `EthereumMCPClient`, `toolConfigs` | Server (viem, LangChain) |
| `crypto-wallet/wallet` | `summarizeWallets`, `chainName`, `shortenAddress`, `explorerAddressUrl`, `CHAIN_NAMES`, `WalletInfoData` | Anywhere, no dependencies |
| `crypto-wallet/send` | `validateSend` (form input to a wei transfer), `parseChainId` | Anywhere (viem utils only) |
| `crypto-wallet/components` | `<WalletInfo variant="card" \| "floating" />` | Client (`'use client'`) |
| `crypto-wallet/privy` | `<PrivyWalletProvider appId>`, `<EmbeddedWallet />` | Client; pulls in `@privy-io/react-auth`, so load it lazily |

`ai-broker-web` consumes the package from TypeScript source (aliases in its
`vite.config.ts`, `vitest.config.ts` and `tsconfig.json`), like `investing`, so
no build is needed during development. `bun run build` emits `dist/` for other
consumers.

```tsx
import { WalletInfo } from "crypto-wallet/components"

<WalletInfo variant="card" fallback={<ConnectWallet />} />
```

```ts
import { getWalletAwareTools } from "crypto-wallet"

const tools = getWalletAwareTools({ address, chainId }) // LangChain DynamicStructuredTools
```

## Layout

| Path | Origin in crypto-wallet-ai |
| --- | --- |
| `src/components/WalletInfo.tsx` | `src/components/wallet/WalletInfo.tsx` (adds the inline `card` variant and a `fallback`) |
| `src/privy/`, `src/send.ts` | New: the Privy embedded wallet (not in crypto-wallet-ai) |
| `src/wallet.ts` | Logic of `src/app/api/wallet/info/route.ts`, made framework-free |
| `src/server-tools.ts` | `src/lib/ethereum-api/server-tools.ts` |
| `src/langchain-tools.ts` | `src/lib/ethereum-api/langchain-tools.ts` |
| `src/mcp-client.ts`, `src/mcp/tools-config.js` | `src/lib/ethereum-api/mcp-client.ts`, `mcp-server/src/tools-config.js` |
| `server/` | Reference servers, not built or deployed: the Express JSON-RPC API (`server.js`, `jsonrpc.js`, `ethereumProvider.js`, `ethereum-openapi.yaml`), the mcp-use Ethereum MCP server (`mcp-server/`), and the chat app's LangChain MCP adapter (`ethereum-mcp-langchain-adapter.ts`, which depends on that app's `BaseMCPServer`) |
| `docs/` | `WALLET_INTEGRATION.md`, `ETHEREUM_INTEGRATION.md`, `MCP_CONFIGURATION.md`, `SETUP_MCP_SERVERS.md`, `docs/langchain-mcp-integration.md`, and `src/lib/ethereum-api/{README,QUICKSTART,metamask-api}.md` |
| `examples/` | `examples/` |

The docs are copied unchanged, so file paths inside them refer to the
crypto-wallet-ai layout; use the table above to map them.

## Scripts

```bash
bun run test        # vitest
bun run type-check
bun run build       # tsc -> dist/
```
