import { useEffect, useState } from "react"
import type { StockData } from "@/components/investing/shared/stock-list"

/**
 * The stocks an admin featured (admin → Stocks), with live quotes. Empty until
 * an admin features something, in which case the scanner hides the tab.
 */
export function useFeaturedStocks() {
  const [stocks, setStocks] = useState<StockData[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/stocks/featured")
        const json = await res.json()
        const featured: Array<{ symbol: string; label: string | null }> = json.success ? json.data : []
        const quoted = await Promise.all(
          featured.map(async ({ symbol, label }): Promise<StockData> => {
            const fallback = { symbol, name: label || symbol, price: 0, change: 0, changePercent: 0, volume: 0 }
            try {
              const qRes = await fetch(`/api/stocks/quote/${encodeURIComponent(symbol)}`)
              const qJson = await qRes.json()
              const p = qJson.success ? qJson.data?.price : null
              if (!p) return fallback
              return {
                symbol,
                name: label || p.longName || p.shortName || symbol,
                price: p.regularMarketPrice ?? 0,
                change: p.regularMarketChange ?? 0,
                changePercent: p.regularMarketChangePercent ?? 0,
                volume: p.regularMarketVolume ?? 0,
              }
            } catch {
              return fallback
            }
          }),
        )
        if (!cancelled) setStocks(quoted)
      } catch (error) {
        console.error("Failed to fetch featured stocks", error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return { featuredStocks: stocks, loading }
}
