/**
 * crypto-wallet — server entry.
 *
 * Wallet-aware Ethereum LangChain tools, generic Ethereum query tools, and the
 * HTTP client for the Ethereum MCP server. UI lives under
 * `crypto-wallet/components`; framework-free helpers under `crypto-wallet/wallet`.
 */
export * from './wallet';
export { getWalletAwareTools } from './server-tools';
export type { WalletContext } from './server-tools';
export {
  generateEthereumTools,
  generateCommonEthereumTools,
  generateWalletTools,
  generateBlockchainQueryTools,
} from './langchain-tools';
export { EthereumMCPClient, getEthereumMCPClient, resetEthereumMCPClient } from './mcp-client';
export { toolConfigs, toolConfigMap } from './mcp/tools-config.js';
export { validateSend, parseChainId } from './send';
export type { SendRequest, SendValidation } from './send';
