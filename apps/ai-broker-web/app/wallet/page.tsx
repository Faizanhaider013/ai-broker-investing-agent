"use client"

import Link from "next/link"
import { Loader2, LogIn, Wallet } from "lucide-react"
import { WalletInfo } from "crypto-wallet/components"
import { useSession } from "@/lib/auth/client"
import { SiweSignIn } from "@/components/auth/siwe-signin"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

/**
 * Crypto Wallet — the wallet from crypto-wallet-ai, mounted as a sidebar page.
 * Shows the wallets linked through Sign-In with Ethereum; with none linked it
 * offers the MetaMask sign-in.
 */
export default function WalletPage() {
  const { data: session, isPending } = useSession()

  const connect = (
    <Card className="p-6 space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">No wallet connected</h2>
        <p className="text-sm text-muted-foreground">
          Sign in with your Ethereum wallet (MetaMask or any injected wallet) to link it to your account.
        </p>
      </div>
      <SiweSignIn redirectTo="/wallet" />
    </Card>
  )

  return (
    <div className="mx-auto w-full max-w-2xl p-4 md:p-8 space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-green-500/10 rounded-full">
          <Wallet className="h-5 w-5 text-green-500" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Crypto Wallet</h1>
          <p className="text-sm text-muted-foreground">Your linked Ethereum wallets and networks.</p>
        </div>
      </div>

      {isPending ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !session?.user ? (
        <Card className="p-6 space-y-4">
          <p className="text-sm text-muted-foreground">Sign in to see your wallet.</p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/login?redirectTo=/wallet">
                <LogIn className="mr-2 h-4 w-4" />
                Sign in
              </Link>
            </Button>
          </div>
          <SiweSignIn redirectTo="/wallet" />
        </Card>
      ) : (
        <WalletInfo variant="card" fallback={connect} />
      )}
    </div>
  )
}
