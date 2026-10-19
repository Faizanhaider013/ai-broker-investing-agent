# CLAUDE.md — `crypto-wallet`

Private. The wallet from `vtempest/crypto-wallet-ai`, ported as a package:
`<WalletInfo />`, wallet-aware Ethereum LangChain tools, generic Ethereum
query tools, the Ethereum MCP client, the original docs, and reference servers.
Full map in the package's `README.md`.

## Things that bite

- **Three entry points, on purpose.** `crypto-wallet/components` (client) and
  `crypto-wallet/wallet` (no dependencies) must never import viem or
  LangChain, or the browser bundle pulls them in. Server tools live only in
  the bare `crypto-wallet` entry.
- **The app consumes it from source.** Aliases live in `ai-broker-web`'s
  `vite.config.ts`, `vitest.config.ts` and `tsconfig.json`; a new subpath
  export needs an alias in all three, listed before the bare name.
- **`server/` is reference only.** Express and mcp-use servers that do not run
  on Workers; tsc excludes them and nothing imports them.
- **Read-only by design.** The wallet-aware tools query balances, gas and
  transactions over public RPC. Nothing here holds a key or signs; keep it
  that way — signing belongs in the user's wallet.
- `docs/` is copied verbatim from crypto-wallet-ai, so paths inside it use that
  repo's layout.

## Commands

```bash
bun run test        # vitest
bun run type-check
bun run build       # tsc -> dist/
```
