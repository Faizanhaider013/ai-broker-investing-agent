'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePrivy, useSendTransaction, useWallets } from '@privy-io/react-auth';
import { formatEther } from 'viem';
import { KeyRound, Link as LinkIcon, Loader2, LogOut, RefreshCw, Send, Wallet } from 'lucide-react';
import { chainName, explorerAddressUrl, shortenAddress } from '../wallet';
import { parseChainId, validateSend } from '../send';

/** Privy reports its embedded wallets with these client types. */
const EMBEDDED_CLIENT_TYPES = new Set(['privy', 'privy-v2']);

const card = 'bg-background border border-border rounded-lg shadow-sm';
const button =
  'inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none';
const primary = `${button} bg-primary text-primary-foreground hover:bg-primary/90`;
const secondary = `${button} border border-border hover:bg-muted`;
const input =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

/**
 * In-app wallet powered by Privy: log in, get an embedded Ethereum wallet,
 * see its address and balance, send the native asset, export the key.
 * Must render inside `<PrivyWalletProvider>`.
 */
export function EmbeddedWallet() {
  const { ready, authenticated, login, logout, user, createWallet, exportWallet } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const embedded = useMemo(
    () => wallets.find((w) => EMBEDDED_CLIENT_TYPES.has(w.walletClientType)),
    [wallets],
  );

  if (!ready) {
    return (
      <div className={`${card} p-6 flex justify-center`}>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className={`${card} p-6 space-y-3`}>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">In-app wallet</h2>
          <p className="text-sm text-muted-foreground">
            Log in with email or a social account and we create a wallet for you. No browser extension needed.
          </p>
        </div>
        <button className={primary} onClick={() => login()}>
          <Wallet className="h-4 w-4" />
          Create or open wallet
        </button>
      </div>
    );
  }

  if (!embedded) {
    return (
      <div className={`${card} p-6 space-y-3`}>
        <p className="text-sm text-muted-foreground">
          {walletsReady ? 'You are logged in but have no in-app wallet yet.' : 'Loading your wallet…'}
        </p>
        <div className="flex flex-wrap gap-2">
          {walletsReady && (
            <button className={primary} onClick={() => createWallet()}>
              <Wallet className="h-4 w-4" />
              Create wallet
            </button>
          )}
          <button className={secondary} onClick={() => logout()}>
            <LogOut className="h-4 w-4" />
            Log out
          </button>
        </div>
      </div>
    );
  }

  return (
    <EmbeddedWalletCard
      address={embedded.address}
      chainId={parseChainId(embedded.chainId) ?? 1}
      getProvider={() => embedded.getEthereumProvider()}
      account={user?.email?.address}
      onExport={() => exportWallet({ address: embedded.address })}
      onLogout={() => logout()}
    />
  );
}

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

function EmbeddedWalletCard({
  address,
  chainId,
  getProvider,
  account,
  onExport,
  onLogout,
}: {
  address: string;
  chainId: number;
  getProvider: () => Promise<Eip1193>;
  account?: string;
  onExport: () => void;
  onLogout: () => void;
}) {
  const [balance, setBalance] = useState<string | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const { sendTransaction } = useSendTransaction();

  const refreshBalance = useCallback(async () => {
    setLoadingBalance(true);
    try {
      const provider = await getProvider();
      const wei = (await provider.request({ method: 'eth_getBalance', params: [address, 'latest'] })) as string;
      setBalance(formatEther(BigInt(wei)));
    } catch (err) {
      console.error('Failed to read wallet balance:', err);
      setBalance(null);
    } finally {
      setLoadingBalance(false);
    }
    // getProvider is recreated each render; the address and chain are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, chainId]);

  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);

  const onSend = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setTxHash(null);
    const result = validateSend(to, amount, address);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSending(true);
    try {
      // Privy shows its own confirmation modal before anything is signed.
      const { hash } = await sendTransaction(
        { to: result.request.to, value: result.request.value, chainId },
        { address },
      );
      setTxHash(hash);
      setTo('');
      setAmount('');
      refreshBalance();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The transaction was not sent.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={`${card} divide-y divide-border`}>
      <div className="p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1.5 bg-green-500/10 rounded-full">
            <Wallet className="h-4 w-4 text-green-500" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">In-app wallet</div>
            <div className="text-xs text-muted-foreground truncate">
              {chainName(chainId)}
              {account ? ` · ${account}` : ''}
            </div>
          </div>
        </div>
        <button className={secondary} onClick={onLogout} aria-label="Log out of in-app wallet">
          <LogOut className="h-4 w-4" />
        </button>
      </div>

      <div className="p-4 space-y-3">
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Address</div>
          <div className="flex items-center gap-2">
            <code className="text-xs font-mono bg-muted px-2 py-1 rounded flex-1 break-all">{address}</code>
            <a
              href={explorerAddressUrl(address, chainId)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:text-blue-600"
              aria-label="View on block explorer"
              title={shortenAddress(address)}
            >
              <LinkIcon className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-muted-foreground">Balance</div>
            <div className="text-lg font-semibold">
              {balance === null ? '—' : `${Number(balance).toFixed(6)} ETH`}
            </div>
          </div>
          <button className={secondary} onClick={refreshBalance} disabled={loadingBalance} aria-label="Refresh balance">
            <RefreshCw className={`h-4 w-4 ${loadingBalance ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <form className="p-4 space-y-3" onSubmit={onSend}>
        <div className="text-sm font-semibold">Send</div>
        <input
          className={input}
          placeholder="Recipient 0x…"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <input
          className={input}
          placeholder="Amount in ETH, e.g. 0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        {txHash && (
          <p className="text-sm text-green-600 break-all">
            Sent: <code className="font-mono text-xs">{txHash}</code>
          </p>
        )}
        <button className={primary} type="submit" disabled={sending}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Send
        </button>
      </form>

      <div className="p-4">
        <button className={secondary} onClick={onExport}>
          <KeyRound className="h-4 w-4" />
          Export private key
        </button>
        <p className="mt-2 text-xs text-muted-foreground">
          Export opens Privy&apos;s secure window so you can move this wallet to MetaMask or another app.
        </p>
      </div>
    </div>
  );
}
