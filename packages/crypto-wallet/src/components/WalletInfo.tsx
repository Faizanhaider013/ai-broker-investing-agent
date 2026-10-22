'use client';

import { useEffect, useState } from 'react';
import { Wallet, Link as LinkIcon, ChevronDown, ChevronUp } from 'lucide-react';
import { chainName, explorerAddressUrl, shortenAddress, type WalletInfoData } from '../wallet';

export interface WalletInfoProps {
  /** Endpoint returning `WalletInfoData`. Defaults to `/api/wallet/info`. */
  endpoint?: string;
  /**
   * `floating` is the original crypto-wallet-ai badge pinned to the bottom
   * right of the screen; `card` renders inline, for a page or panel.
   */
  variant?: 'floating' | 'card';
  /** Start expanded (the card variant defaults to expanded). */
  defaultExpanded?: boolean;
  /** Rendered when the user has no linked wallet or isn't signed in. */
  fallback?: React.ReactNode;
}

export function WalletInfo({
  endpoint = '/api/wallet/info',
  variant = 'floating',
  defaultExpanded = variant === 'card',
  fallback = null,
}: WalletInfoProps) {
  const [walletData, setWalletData] = useState<WalletInfoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  useEffect(() => {
    let cancelled = false;
    const fetchWalletInfo = async () => {
      try {
        const response = await fetch(endpoint);
        if (response.ok) {
          const data = await response.json();
          if (!cancelled) setWalletData(data);
        }
      } catch (error) {
        console.error('Failed to fetch wallet info:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchWalletInfo();
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  if (loading) {
    return null;
  }
  if (!walletData) {
    return <>{fallback}</>;
  }

  const panel = (
    <div
      className="bg-background/95 backdrop-blur-sm border border-border rounded-lg shadow-lg transition-all duration-200 hover:shadow-xl"
      style={variant === 'floating' ? { minWidth: '280px', maxWidth: '320px' } : undefined}
    >
      {/* Header - Always visible, clickable to expand/collapse */}
      <div
        className="flex items-center justify-between p-3 cursor-pointer hover:bg-muted/50 rounded-t-lg transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-green-500/10 rounded-full">
            <Wallet className="h-4 w-4 text-green-500" />
          </div>
          <div>
            <div className="text-sm font-semibold">Connected Wallet</div>
            <div className="text-xs text-muted-foreground">{chainName(walletData.chainId)}</div>
          </div>
        </div>
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      {/* Expandable content */}
      {isExpanded && (
        <div className="border-t border-border p-3 space-y-3">
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1">Primary Address</div>
            <div className="flex items-center gap-2">
              <code className="text-xs font-mono bg-muted px-2 py-1 rounded flex-1" title={walletData.address}>
                {shortenAddress(walletData.address)}
              </code>
              <a
                href={explorerAddressUrl(walletData.address, walletData.chainId)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:text-blue-600 transition-colors"
                onClick={(e) => e.stopPropagation()}
                aria-label="View on block explorer"
              >
                <LinkIcon className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>

          {walletData.wallets.length > 1 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                All Wallets ({walletData.wallets.length})
              </div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {walletData.wallets.map((wallet) => (
                  <div
                    key={`${wallet.address}:${wallet.chainId}`}
                    className="text-xs flex items-center justify-between bg-muted/50 px-2 py-1 rounded"
                  >
                    <code className="font-mono">{shortenAddress(wallet.address)}</code>
                    <span className="text-[10px] text-muted-foreground ml-2">
                      {chainName(wallet.chainId)} {wallet.isPrimary && '★'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return variant === 'floating' ? <div className="fixed bottom-4 right-4 z-50">{panel}</div> : panel;
}
