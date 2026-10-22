"use client"

// MUST stay the first import: sets the API base-URL global before
// research-agent-ui's bundled qwksearch-api-client captures it.
import "./base-url"

import "react-reason-editor/style.css"
import "react-reason-editor-sidebar/style.css"

import { useCallback, useEffect, useState } from "react"
import { MainViewProvider, ResearchWorkspaceView, configureResearchAgentUI } from "research-agent-ui/workspace"
import { SettingsDialog } from "@/components/settings/settings-dialog"
import { prepareDocStorage } from "./doc-storage"
import { syncSavedPreferences } from "./preferences"
import { QwksearchProviders } from "./Providers"

/**
 * The research workspace (chat tabs, the REASON docs editor and its files
 * sidebar) with the agent's "settings" button opening AI Broker's settings
 * dialog on its QwkSearch section, instead of a `/settings` route this app
 * doesn't serve. The workspace itself keeps `?chat=` / `?docs=` in the URL
 * and handles opening chats from history.
 */
function ResearchWorkspace() {
  const [settingsOpen, setSettingsOpen] = useState(false)

  const openSettings = useCallback(() => {
    setSettingsOpen(true)
    return true
  }, [])

  useEffect(() => {
    configureResearchAgentUI({ onOpenSettings: openSettings })
    return () => configureResearchAgentUI({ onOpenSettings: undefined })
  }, [openSettings])

  return (
    <>
      <ResearchWorkspaceView />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} initialSection="qwksearch" />
    </>
  )
}

/**
 * The QwkSearch research agent (research-agent-ui's chat, search, article
 * reader and REASON docs workspace), running against qwksearch.com as the
 * user's linked QwkSearch account, or as a guest. Documents are stored on the
 * AI Broker account (see ./doc-storage.ts).
 */
export default function ResearchAgent() {
  const [ready, setReady] = useState(false)

  // The agent and the editor read their settings and documents from
  // localStorage once, as they mount; copy the account's saved ones there
  // first so they apply on this device too.
  useEffect(() => {
    void Promise.allSettled([syncSavedPreferences(), prepareDocStorage()]).finally(() => setReady(true))
  }, [])

  if (!ready) return null
  return (
    <QwksearchProviders>
      <MainViewProvider docsEnabled>
        <ResearchWorkspace />
      </MainViewProvider>
    </QwksearchProviders>
  )
}
