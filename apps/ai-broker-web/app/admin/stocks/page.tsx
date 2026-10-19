"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Loader2, Star, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface StockControl {
  symbol: string;
  published: boolean;
  label: string | null;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

export default function AdminStocksPage() {
  const [stocks, setStocks] = useState<StockControl[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [symbols, setSymbols] = useState("");
  const [label, setLabel] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/stocks");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setStocks(body.stocks);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load stocks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(body: Record<string, unknown>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/stocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? `Request failed (${res.status})`);
      setNotice(message);
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove(symbol: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/stocks?symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? `Request failed (${res.status})`);
      setNotice(`${symbol} is back to the default listing.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  async function add(published: boolean) {
    const list = symbols
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0) return;
    const ok = await save(
      list.length === 1
        ? { symbol: list[0], published, label: label || undefined }
        : { symbols: list, published },
      `${list.join(", ")} ${published ? "featured" : "hidden"}.`,
    );
    if (ok) {
      setSymbols("");
      setLabel("");
    }
  }

  const featured = stocks.filter((s) => s.published);
  const hidden = stocks.filter((s) => !s.published);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Stocks</h1>
        <p className="text-muted-foreground text-sm">
          Featured stocks are published to the public featured list (<code>/api/stocks/featured</code>, the Featured tab on Markets).
          Hidden stocks are dropped from the trending, gainers and screener lists.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add stocks</CardTitle>
          <CardDescription>One or more tickers, separated by spaces or commas. A display name applies to a single ticker.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Input placeholder="AAPL, MSFT, NVDA" value={symbols} onChange={(e) => setSymbols(e.target.value)} className="w-64" />
          <Input placeholder="Display name (optional)" value={label} onChange={(e) => setLabel(e.target.value)} className="w-56" />
          <Button disabled={busy || !symbols.trim()} onClick={() => add(true)}>
            <Star className="mr-1 h-4 w-4" /> Feature
          </Button>
          <Button variant="outline" disabled={busy || !symbols.trim()} onClick={() => add(false)}>
            <EyeOff className="mr-1 h-4 w-4" /> Hide
          </Button>
        </CardContent>
      </Card>

      {notice && <p className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm">{notice}</p>}
      {error && <p className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">{error}</p>}

      {loading && stocks.length === 0 ? (
        <Loader2 className="text-muted-foreground mx-auto h-5 w-5 animate-spin" />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {[
            { title: "Featured", rows: featured, empty: "No featured stocks yet." },
            { title: "Hidden", rows: hidden, empty: "No hidden stocks." },
          ].map(({ title, rows, empty }) => (
            <Card key={title}>
              <CardHeader>
                <CardTitle className="text-base">
                  {title} <Badge variant="secondary">{rows.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {rows.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{empty}</p>
                ) : (
                  <ul className="divide-y">
                    {rows.map((s) => (
                      <li key={s.symbol} className="flex items-center gap-2 py-2 text-sm">
                        <span className="w-20 font-mono font-semibold">{s.symbol}</span>
                        <span className="text-muted-foreground flex-1 truncate" title={s.updatedBy ? `by ${s.updatedBy}` : undefined}>
                          {s.label ?? ""}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => save({ symbol: s.symbol, published: !s.published }, `${s.symbol} ${s.published ? "hidden" : "featured"}.`)}
                        >
                          {s.published ? <EyeOff className="mr-1 h-4 w-4" /> : <Eye className="mr-1 h-4 w-4" />}
                          {s.published ? "Hide" : "Feature"}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove ${s.symbol}`} onClick={() => remove(s.symbol)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
