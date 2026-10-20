"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { authClient } from "@/lib/auth/client"

/**
 * Loaded inside the native app's own window by its aibroker:// deep-link
 * handler. Spends the single-use token from /auth/native-complete, which sets
 * the session cookie in this webview's cookie jar, then goes home.
 */
export default function NativeCallbackPage() {
  const router = useRouter()
  const [status, setStatus] = useState<"working" | "error">("working")

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token")
    if (!token) {
      setStatus("error")
      return
    }

    let cancelled = false

    async function verify(token: string) {
      const { error } = await authClient.oneTimeToken.verify({ token })
      if (cancelled) return
      if (error) {
        console.error("[auth] one-time token verify failed:", error)
        setStatus("error")
        return
      }
      router.replace("/")
      router.refresh()
    }

    void verify(token)
    return () => {
      cancelled = true
    }
  }, [router])

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="max-w-sm text-center space-y-3">
        {status === "working" && (
          <p className="text-sm text-muted-foreground animate-pulse">Finishing sign-in…</p>
        )}
        {status === "error" && (
          <>
            <p className="text-sm font-medium">This sign-in link is no longer valid.</p>
            <p className="text-sm text-muted-foreground">
              Sign-in links expire a few minutes after they&apos;re issued. Go back and try
              &quot;Continue in your browser&quot; again.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
