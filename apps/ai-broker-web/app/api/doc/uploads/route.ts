import { db } from "@/lib/db"
import { getSession } from "@/lib/auth/session"
import { serverEnv } from "@/lib/env/runtime"
import { qwksearchOrigin } from "@/lib/qwksearch/connect"
import { loadConnection } from "@/lib/qwksearch/store"

/**
 * Pass-through to QwkSearch's file upload endpoint (as debate-ai.com has).
 *
 * research-agent-ui's file-upload hook issues a raw same-origin
 * `fetch("/api/doc/uploads")` with no base-URL hook, so this route forwards
 * that one call to QwkSearch — with the user's linked QwkSearch API key, when
 * there is one, so the upload lands on their QwkSearch account.
 */
async function forward(request: Request): Promise<Response> {
  const headers = new Headers()
  const contentType = request.headers.get("content-type")
  if (contentType) headers.set("content-type", contentType)

  const session = await getSession()
  const connection = session ? await loadConnection(db, session.user.id).catch(() => null) : null
  if (connection) headers.set("X-API-Key", connection.apiKey)

  let upstream: Response
  try {
    upstream = await fetch(new URL("/api/doc/uploads", qwksearchOrigin(serverEnv("QWKSEARCH_ORIGIN"))), {
      method: request.method,
      headers,
      // Buffered rather than streamed: streaming request bodies need half-duplex
      // support that isn't available on every deploy target.
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    })
  } catch {
    return Response.json({ error: "QwkSearch is unreachable. Try the upload again." }, { status: 502 })
  }

  const responseHeaders = new Headers()
  const upstreamType = upstream.headers.get("content-type")
  if (upstreamType) responseHeaders.set("content-type", upstreamType)
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
}

export async function POST(request: Request) {
  return forward(request)
}

export async function GET(request: Request) {
  return forward(request)
}
