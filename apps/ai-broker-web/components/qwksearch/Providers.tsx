"use client"

// MUST stay the first import: sets the API base-URL global before
// research-agent-ui's bundled qwksearch-api-client captures it.
import "./base-url"

import type { ReactNode } from "react"
import { ChatProvider, ExtractPanelProvider, SessionProvider, configureResearchAgentUI } from "research-agent-ui"
import { authClient, useQwkSearchSession } from "./connect-auth"
import { GrabBaseScope } from "./GrabBaseScope"

configureResearchAgentUI({
  appName: "AI Broker",
  getAutoMediaSearch: () => true,
})

/**
 * Holds the embed back until the linked QwkSearch account (if any) is known,
 * so its first requests — the model list, chat history — already carry the
 * user's key instead of running as a guest. One same-origin request.
 */
function ConnectSessionGate({ children }: { children: ReactNode }) {
  const { isPending } = useQwkSearchSession()
  return isPending ? null : <>{children}</>
}

/**
 * Provider stack for the embedded QwkSearch research agent — debate-ai.com's
 * `QwksearchProviders` minus the REASON workspace pieces, with the
 * "Sign in with QwkSearch" connect client in place of better-auth. The host
 * app already supplies the theme provider and the toaster.
 */
export function QwksearchProviders({ children }: { children: ReactNode }) {
  return (
    <GrabBaseScope>
      <ConnectSessionGate>
        <SessionProvider authClient={authClient} enableGoogleOneTap={false}>
          <ExtractPanelProvider>
            <ChatProvider>{children}</ChatProvider>
          </ExtractPanelProvider>
        </SessionProvider>
      </ConnectSessionGate>
    </GrabBaseScope>
  )
}
