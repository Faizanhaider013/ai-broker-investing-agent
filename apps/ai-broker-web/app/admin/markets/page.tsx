"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Eye, EyeOff, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface MarketRow {
  id: string;
  question: string;
  slug: string;
  eventSlug: string | null;
  category: string | null;
  volume24hr: number | null;
  volumeTotal: number | null;
  active: boolean | null;
  closed: boolean | null;
  endDate: string | null;
  published: boolean;
  controlUpdatedBy: string | null;
}

interface MarketsResponse {
  markets: MarketRow[];
  page: number;
  pageCount: number;
  matched: number;
  counts: { total: number; published: number; unpublished: number };
  categories: string[];
}

const PAGE_SIZE = 25;
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function marketUrl(m: MarketRow): string {
  return `https://polymarket.com/event/${m.eventSlug ?? m.slug}`;
}

export default function AdminMarketsPage() {
  const [data, setData] = useState<MarketsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("volume24hr");
  const [activeOnly, setActiveOnly] = useState(true);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [refillSize, setRefillSize] = useState("500");
  const [refillPrices, setRefillPrices] = useState(false);
  const [refilling, setRefilling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      page: String(page),
      limit: String(PAGE_SIZE),
      status,
      sort,
      category,
    });
    if (search) params.set("q", search);
    if (activeOnly) params.set("active", "true");
    try {
      const res = await fetch(`/api/admin/markets?${params}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setData(body);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load markets");
    } finally {
      setLoading(false);
    }
  }, [page, status, sort, category, search, activeOnly]);

  useEffect(() => {
    load();
  }, [load]);

  async function publish(body: Record<string, unknown>) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/markets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? `Request failed (${res.status})`);
      setNotice(`${result.updated} market${result.updated === 1 ? "" : "s"} ${result.published ? "published" : "unpublished"}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function refill() {
    setRefilling(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/markets/refill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxMarkets: Number(refillSize), priceHistory: refillPrices }),
      });
      const result = await res.json();
      if (!res.ok || !result.success) throw new Error(result.error ?? `Refill failed (${res.status})`);
      setNotice(result.message);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refill failed");
    } finally {
      setRefilling(false);
    }
  }

  const markets = data?.markets ?? [];
  const allSelected = markets.length > 0 && markets.every((m) => selected.has(m.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Prediction markets</h1>
        <p className="text-muted-foreground text-sm">
          Unpublished markets are hidden from the public market lists and search. New markets from a sync are published by default.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {(["total", "published", "unpublished"] as const).map((key) => (
          <Card key={key}>
            <CardContent className="pt-4">
              <div className="text-muted-foreground text-xs capitalize">{key}</div>
              <div className="text-2xl font-semibold">{(data?.counts[key] ?? 0).toLocaleString()}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Refill from Polymarket</CardTitle>
          <CardDescription>
            Upserts the top open markets by 24h volume and retires markets whose end date has passed. Publish decisions are kept.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            Markets
            <Input
              type="number"
              min={1}
              max={5000}
              value={refillSize}
              onChange={(e) => setRefillSize(e.target.value)}
              className="w-24"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={refillPrices} onChange={(e) => setRefillPrices(e.target.checked)} />
            Include price history (slower)
          </label>
          <Button onClick={refill} disabled={refilling}>
            {refilling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {refilling ? "Refilling…" : "Refill markets"}
          </Button>
        </CardContent>
      </Card>

      {notice && <p className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm">{notice}</p>}
      {error && <p className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">{error}</p>}

      <Card>
        <CardContent className="space-y-4 pt-6">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              setSearch(q.trim());
            }}
          >
            <Input placeholder="Search question, slug or id" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
            <select
              aria-label="Category"
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">All categories</option>
              {(data?.categories ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              aria-label="Status"
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">All</option>
              <option value="published">Published</option>
              <option value="unpublished">Unpublished</option>
            </select>
            <select
              aria-label="Sort"
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="volume24hr">24h volume</option>
              <option value="volumeTotal">Total volume</option>
              <option value="updatedAt">Last synced</option>
              <option value="endDate">Ending soonest</option>
            </select>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={activeOnly}
                onChange={(e) => {
                  setActiveOnly(e.target.checked);
                  setPage(1);
                }}
              />
              Active only
            </label>
            <Button type="submit" variant="secondary" size="sm">
              Search
            </Button>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-sm">{selected.size} selected</span>
            <Button size="sm" variant="outline" disabled={busy || selected.size === 0} onClick={() => publish({ ids: [...selected], published: true })}>
              <Eye className="mr-1 h-4 w-4" /> Publish
            </Button>
            <Button size="sm" variant="outline" disabled={busy || selected.size === 0} onClick={() => publish({ ids: [...selected], published: false })}>
              <EyeOff className="mr-1 h-4 w-4" /> Unpublish
            </Button>
            <span className="ml-auto flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  const scope = category === "all" ? "every market" : `every ${category} market`;
                  if (window.confirm(`Publish ${scope}?`)) publish({ all: true, published: true, category });
                }}
              >
                Publish all{category === "all" ? "" : ` ${category}`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  const scope = category === "all" ? "every market" : `every ${category} market`;
                  if (window.confirm(`Unpublish ${scope}? They will disappear from the public site.`)) publish({ all: true, published: false, category });
                }}
              >
                Unpublish all{category === "all" ? "" : ` ${category}`}
              </Button>
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground border-b text-left text-xs">
                <tr>
                  <th className="w-8 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(markets.map((m) => m.id)))}
                    />
                  </th>
                  <th className="py-2">Market</th>
                  <th className="py-2">Category</th>
                  <th className="py-2 text-right">24h vol</th>
                  <th className="py-2 text-right">Total vol</th>
                  <th className="py-2">Ends</th>
                  <th className="py-2">Status</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {loading && markets.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center">
                      <Loader2 className="text-muted-foreground mx-auto h-5 w-5 animate-spin" />
                    </td>
                  </tr>
                ) : markets.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-muted-foreground py-8 text-center">
                      No markets match. Refill from Polymarket to load some.
                    </td>
                  </tr>
                ) : (
                  markets.map((m) => (
                    <tr key={m.id} className="border-b last:border-0">
                      <td className="py-2">
                        <input type="checkbox" aria-label={`Select ${m.question}`} checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
                      </td>
                      <td className="max-w-md py-2">
                        <a href={marketUrl(m)} target="_blank" rel="noreferrer" className="hover:underline">
                          {m.question} <ExternalLink className="inline h-3 w-3 opacity-50" />
                        </a>
                        {!m.active || m.closed ? <Badge variant="outline" className="ml-2">closed</Badge> : null}
                      </td>
                      <td className="py-2">{m.category ?? "—"}</td>
                      <td className="py-2 text-right tabular-nums">{usd.format(m.volume24hr ?? 0)}</td>
                      <td className="py-2 text-right tabular-nums">{usd.format(m.volumeTotal ?? 0)}</td>
                      <td className="py-2 whitespace-nowrap">{m.endDate ? new Date(m.endDate).toLocaleDateString() : "—"}</td>
                      <td className="py-2">
                        <Badge variant={m.published ? "default" : "secondary"} title={m.controlUpdatedBy ? `by ${m.controlUpdatedBy}` : undefined}>
                          {m.published ? "Published" : "Unpublished"}
                        </Badge>
                      </td>
                      <td className="py-2 text-right">
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => publish({ ids: [m.id], published: !m.published })}>
                          {m.published ? "Unpublish" : "Publish"}
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {(data?.matched ?? 0).toLocaleString()} matching · page {data?.page ?? page} of {data?.pageCount ?? 1}
            </span>
            <span className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" variant="outline" disabled={page >= (data?.pageCount ?? 1) || loading} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
