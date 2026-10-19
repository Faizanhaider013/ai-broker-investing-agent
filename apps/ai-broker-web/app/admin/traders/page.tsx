"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Source = "polymarket" | "zulu" | "nvstly";

interface TopTrader {
  id: string;
  rank: number;
  name: string;
  pnl: number | null;
  volume: number | null;
  winRate: number | null;
  profileUrl: string | null;
  updatedAt: string | null;
}

const SOURCES: Array<{ key: Source; name: string; pnlLabel: string; volumeLabel: string }> = [
  { key: "polymarket", name: "Polymarket", pnlLabel: "PnL", volumeLabel: "Volume" },
  { key: "zulu", name: "ZuluTrade", pnlLabel: "ROI profit", volumeLabel: "Trades" },
  { key: "nvstly", name: "NVSTLY", pnlLabel: "Total gain", volumeLabel: "Trades" },
];

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export default function AdminTradersPage() {
  const [source, setSource] = useState<Source>("polymarket");
  const [sort, setSort] = useState("pnl");
  const [limit, setLimit] = useState(50);
  const [traders, setTraders] = useState<TopTrader[]>([]);
  const [counts, setCounts] = useState<Record<Source, number> | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/traders?source=${source}&sort=${sort}&limit=${limit}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setTraders(body.traders);
      setCounts(body.counts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load traders");
    } finally {
      setLoading(false);
    }
  }, [source, sort, limit]);

  useEffect(() => {
    load();
  }, [load]);

  async function sync() {
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/traders/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, limit: 200, orderBy: sort === "vol" ? "VOL" : "PNL" }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error ?? `Sync failed (${res.status})`);
      setNotice(`Synced ${body.synced} ${SOURCES.find((s) => s.key === source)?.name} traders.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  const meta = SOURCES.find((s) => s.key === source)!;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Top traders</h1>
        <p className="text-muted-foreground text-sm">The leaders each copy-trading source has synced, ranked by the metric you pick.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {SOURCES.map((s) => (
          <Button key={s.key} size="sm" variant={s.key === source ? "default" : "outline"} onClick={() => setSource(s.key)}>
            {s.name}
            {counts ? <Badge variant="secondary" className="ml-2">{counts[s.key]}</Badge> : null}
          </Button>
        ))}
        <select
          aria-label="Sort"
          className="border-input bg-background ml-auto h-9 rounded-md border px-2 text-sm"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="pnl">{meta.pnlLabel}</option>
          <option value="vol">{meta.volumeLabel}</option>
          <option value="winRate">Win rate</option>
          <option value="rank">Source rank</option>
        </select>
        <select
          aria-label="Count"
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
        >
          {[25, 50, 100, 200].map((n) => (
            <option key={n} value={n}>
              Top {n}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={sync} disabled={syncing}>
          {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Sync {meta.name}
        </Button>
      </div>

      {notice && <p className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm">{notice}</p>}
      {error && <p className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">{error}</p>}

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground border-b text-left text-xs">
              <tr>
                <th className="py-2">#</th>
                <th className="py-2">Trader</th>
                <th className="py-2 text-right">{meta.pnlLabel}</th>
                <th className="py-2 text-right">{meta.volumeLabel}</th>
                <th className="py-2 text-right">Win rate</th>
                <th className="py-2">Synced</th>
              </tr>
            </thead>
            <tbody>
              {loading && traders.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center">
                    <Loader2 className="text-muted-foreground mx-auto h-5 w-5 animate-spin" />
                  </td>
                </tr>
              ) : traders.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-muted-foreground py-8 text-center">
                    No {meta.name} traders synced yet. Press Sync to fetch them.
                  </td>
                </tr>
              ) : (
                traders.map((t) => (
                  <tr key={t.id} className="border-b last:border-0">
                    <td className="py-2 tabular-nums">{t.rank}</td>
                    <td className="py-2">
                      {t.profileUrl ? (
                        <a href={t.profileUrl} target="_blank" rel="noreferrer" className="hover:underline">
                          {t.name} <ExternalLink className="inline h-3 w-3 opacity-50" />
                        </a>
                      ) : (
                        t.name
                      )}
                    </td>
                    <td className={`py-2 text-right tabular-nums ${(t.pnl ?? 0) < 0 ? "text-red-500" : ""}`}>
                      {t.pnl === null ? "—" : compact.format(t.pnl)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{t.volume === null ? "—" : compact.format(t.volume)}</td>
                    <td className="py-2 text-right tabular-nums">{t.winRate === null ? "—" : `${t.winRate.toFixed(1)}%`}</td>
                    <td className="text-muted-foreground py-2 text-xs whitespace-nowrap">
                      {t.updatedAt ? new Date(t.updatedAt).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
