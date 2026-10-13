"use client"

// MUST stay the first import: sets the API base-URL global before
// research-agent-ui's bundled qwksearch-api-client captures it.
import "./base-url"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChatWindow, configureResearchAgentUI, useChat } from "research-agent-ui"
import { SettingsDialog } from "@/components/settings/settings-dialog"
import { syncSavedPreferences } from "./preferences"
import { QwksearchProviders } from "./Providers"

/**
 * Wires the agent's chat links and settings button to AI Broker: a chat from
 * history opens in place (and is named in `?chat=` for reloads and sharing),
 * and "settings" opens AI Broker's settings dialog on its QwkSearch section
 * instead of a `/settings` route this app doesn't serve.
 */
function ResearchChat() {
  const { chatId, chatTurns, switchToChat } = useChat()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const restored = useRef(false)

  useEffect(() => {
    if (restored.current) return
    restored.current = true
    const fromUrl = new URLSearchParams(window.location.search).get("chat")
    if (fromUrl) switchToChat(fromUrl)
  }, [switchToChat])

  // Mirror the open chat into the address bar once it has a message, without
  // a route transition (that would remount the agent).
  useEffect(() => {
    const url = new URL(window.location.href)
    const next = chatId && chatTurns.length ? chatId : null
    if ((url.searchParams.get("chat") ?? null) === next) return
    if (next) url.searchParams.set("chat", next)
    else url.searchParams.delete("chat")
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`)
  }, [chatId, chatTurns.length])

  const openChat = useCallback(
    (id: string) => {
      switchToChat(id)
      return true
    },
    [switchToChat],
  )
  const openSettings = useCallback(() => {
    setSettingsOpen(true)
    return true
  }, [])

  useEffect(() => {
    configureResearchAgentUI({ onOpenChat: openChat, onOpenSettings: openSettings })
    return () => configureResearchAgentUI({ onOpenChat: undefined, onOpenSettings: undefined })
  }, [openChat, openSettings])

  return (
    <>
      <ChatWindow />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} initialSection="qwksearch" />
    </>
  )
}

/**
 * The QwkSearch research agent (research-agent-ui's chat, search and article
 * reader), running against qwksearch.com as the user's linked QwkSearch
 * account, or as a guest.
 */
export default function ResearchAgent() {
  const [ready, setReady] = useState(false)

  // The agent reads its settings from localStorage once, as it mounts; copy
  // the account's saved ones there first so they apply on this device too.
  useEffect(() => {
    void syncSavedPreferences().finally(() => setReady(true))
  }, [])

  if (!ready) return null
  return (
    <QwksearchProviders>
      <ResearchChat />
    </QwksearchProviders>
  )
}
