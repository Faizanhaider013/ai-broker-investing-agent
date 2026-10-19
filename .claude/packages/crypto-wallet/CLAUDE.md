# CLAUDE.md — `crypto-wallet`

Private. The wallet from `vtempest/crypto-wallet-ai`, ported as a package:
`<WalletInfo />`, wallet-aware Ethereum LangChain tools, generic Ethereum
query tools, the Ethereum MCP client, the original docs, and reference servers.
Full map in the package's `README.md`.

## Things that bite

- **Separate entry points, on purpose.** `crypto-wallet/components` (client)
  and `crypto-wallet/wallet` (no dependencies) must never import LangChain or
  Privy, or every page that shows a wallet pulls them in. Server tools live
  only in the bare `crypto-wallet` entry; Privy only in `crypto-wallet/privy`,
  which the app loads with `React.lazy` (`components/wallet/privy-wallet-section.tsx`).
- **Privy config is runtime, not build time.** `/api/wallet/config` reads
  `PRIVY_APP_ID` / `PRIVY_CLIENT_ID` through `serverEnv`, so setting the
  Worker var needs no rebuild. Without it the page shows a "not set up" note.
- **The app consumes it from source.** Aliases live in `ai-broker-web`'s
  `vite.config.ts`, `vitest.config.ts` and `tsconfig.json`; a new subpath
  export needs an alias in all three, listed before the bare name.
- **`server/` is reference only.** Express and mcp-use servers that do not run
  on Workers; tsc excludes them and nothing imports them.
- **No keys server-side.** The wallet-aware tools only query balances, gas
  and transactions over public RPC. Sends go through Privy's own confirmation
  modal in the browser (`useSendTransaction`); keys stay with Privy or the
  user's wallet. Validate amounts with `validateSend` — it refuses zero,
  malformed amounts, bad recipients and self-sends.
- `docs/` is copied verbatim from crypto-wallet-ai, so paths inside it use that
  repo's layout.

## Commands

```bash
bun run test        # vitest
bun run type-check
bun run build       # tsc -> dist/
```
