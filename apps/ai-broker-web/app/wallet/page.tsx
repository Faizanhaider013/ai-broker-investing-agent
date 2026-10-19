"use client"

import { lazy, Suspense, useEffect, useState } from "react"
import Link from "next/link"
import { Loader2, LogIn, Wallet } from "lucide-react"
import { WalletInfo } from "crypto-wallet/components"
import { useSession } from "@/lib/auth/client"
import { SiweSignIn } from "@/components/auth/siwe-signin"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

const PrivyWalletSection = lazy(() => import("@/components/wallet/privy-wallet-section"))

type WalletConfig = { privyAppId: string | null; privyClientId: string | null }

const spinner = (
  <div className="flex justify-center py-8">
    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
  </div>
)

/**
 * Crypto Wallet. Two ways in:
 * - In-app wallet (Privy): log in, get an embedded wallet, see it and send.
 * - Your own wallet (MetaMask etc.): Sign in with Ethereum, then see the
 *   wallets linked to your AI Broker account.
 */
export default function WalletPage() {
  const { data: session, isPending } = useSession()
  const [config, setConfig] = useState<WalletConfig | null>(null)

  useEffect(() => {
    fetch("/api/wallet/config")
      .then((res) => (res.ok ? res.json() : { privyAppId: null, privyClientId: null }))
      .then(setConfig)
      .catch(() => setConfig({ privyAppId: null, privyClientId: null }))
  }, [])

  const connect = (
    <Card className="p-6 space-y-4">
      <p className="text-sm text-muted-foreground">
        No external wallet linked yet. Sign in with MetaMask or any browser wallet to link it to your account.
      </p>
      <SiweSignIn redirectTo="/wallet" />
    </Card>
  )

  return (
    <div className="mx-auto w-full max-w-2xl p-4 md:p-8 space-y-8">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-green-500/10 rounded-full">
          <Wallet className="h-5 w-5 text-green-500" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Crypto Wallet</h1>
          <p className="text-sm text-muted-foreground">An in-app wallet, plus any Ethereum wallets you have linked.</p>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">In-app wallet</h2>
        {!config ? (
          spinner
        ) : config.privyAppId ? (
          <Suspense fallback={spinner}>
            <PrivyWalletSection appId={config.privyAppId} clientId={config.privyClientId ?? undefined} />
          </Suspense>
        ) : (
          <Card className="p-6">
            <p className="text-sm text-muted-foreground">
              The in-app wallet isn&apos;t set up on this site yet. An administrator needs to set the{" "}
              <code className="font-mono text-xs">PRIVY_APP_ID</code> variable.
            </p>
          </Card>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Your own wallet</h2>
        {isPending ? (
          spinner
        ) : !session?.user ? (
          <Card className="p-6 space-y-4">
            <p className="text-sm text-muted-foreground">
              Already use MetaMask? Sign in with it, or sign in to your account to see linked wallets.
            </p>
            <SiweSignIn redirectTo="/wallet" />
            <Button asChild variant="outline">
              <Link href="/login?redirectTo=/wallet">
                <LogIn className="mr-2 h-4 w-4" />
                Other sign-in options
              </Link>
            </Button>
          </Card>
        ) : (
          <WalletInfo variant="card" fallback={connect} />
        )}
      </section>
    </div>
  )
}
