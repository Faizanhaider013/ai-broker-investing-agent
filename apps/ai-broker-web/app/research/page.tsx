"use client"

import { lazy, Suspense, useSyncExternalStore } from "react"
import { Loader2 } from "lucide-react"

// The research agent is a large bundle (chat, search, article reader, voice),
// so it loads with this page rather than with the app shell.
const ResearchAgent = lazy(() => import("@/components/qwksearch/ResearchAgent"))

const subscribeNever = () => () => {}

const loader = (
  <div className="flex flex-1 items-center justify-center py-16">
    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
  </div>
)

/**
 * /research — the QwkSearch Research Agent, the same research-agent-ui
 * package debate-ai.com embeds. Browser-only: it talks to qwksearch.com's API
 * and reads the agent's settings from localStorage.
 */
export default function ResearchPage() {
  const inBrowser = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {inBrowser ? <Suspense fallback={loader}><ResearchAgent /></Suspense> : loader}
    </div>
  )
}
