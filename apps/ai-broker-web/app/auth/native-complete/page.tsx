"use client"

import { useEffect, useState } from "react"
import { authClient } from "@/lib/auth/client"
import { NATIVE_COMPLETE_PATH, NATIVE_DEEP_LINK_SCHEME } from "@/lib/native/tauri"

/**
 * Opened in the system browser by the native app's "Continue in your browser"
 * button. With a browser session, mints a single-use token and hands it to the
 * app over its deep link; without one, sends the user to sign in first and
 * back here afterwards.
 */
export default function NativeCompletePage() {
  const [status, setStatus] = useState<"working" | "done" | "error">("working")

  useEffect(() => {
    let cancelled = false

    async function handoff() {
      const { data: session } = await authClient.getSession()
      if (cancelled) return
      if (!session?.user) {
        window.location.replace(`/login?redirectTo=${encodeURIComponent(NATIVE_COMPLETE_PATH)}`)
        return
      }

      const { data, error } = await authClient.oneTimeToken.generate()
      if (cancelled) return
      if (error || !data?.token) {
        console.error("[auth] one-time token generation failed:", error)
        setStatus("error")
        return
      }
      setStatus("done")
      window.location.href = `${NATIVE_DEEP_LINK_SCHEME}://auth-callback?token=${encodeURIComponent(data.token)}`
    }

    void handoff()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="max-w-sm text-center space-y-3">
        {status === "working" && (
          <p className="text-sm text-muted-foreground animate-pulse">Signing you in…</p>
        )}
        {status === "done" && (
          <>
            <p className="text-sm font-medium">You&apos;re signed in.</p>
            <p className="text-sm text-muted-foreground">
              Return to the app. It should open automatically; if it doesn&apos;t, close this tab
              and reopen the app yourself.
            </p>
          </>
        )}
        {status === "error" && (
          <>
            <p className="text-sm font-medium">Something went wrong finishing sign-in.</p>
            <p className="text-sm text-muted-foreground">
              Close this tab and try &quot;Continue in your browser&quot; again from the app.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
