// FILE: src/app/watchlist/page.tsx
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Watchlist UI — view, add, remove watched games for discount tracking
//   SCOPE: Client component with form, table, and API integration
//   DEPENDS: M-API
//   LINKS: M-UI
// END_MODULE_CONTRACT

"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Loader2, ExternalLink } from "lucide-react";

interface PriceSnapshot {
    id: number;
    priceRuFinal: number | null;
    discountPct: number;
    priceKzInRub: number | null;
    platiPriceRub: number | null;
    checkedAt: string;
}

interface WatchedGame {
    id: number;
    appId: string;
    name: string;
    addedAt: string;
    lastDiscountPct: number;
    prices: PriceSnapshot[];
}

interface SearchResult {
    appId: string;
    name: string;
}

export default function WatchlistPage() {
    const [games, setGames] = useState<WatchedGame[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState("");
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState("");
    const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);

    const fetchWatchlist = useCallback(async () => {
        const res = await fetch("/api/watchlist");
        const data = await res.json();
        setGames(data);
        setLoading(false);
    }, []);

    useEffect(() => {
        let cancelled = false;

        async function loadWatchlist() {
            const res = await fetch("/api/watchlist");
            const data = await res.json();
            if (!cancelled) {
                setGames(data);
                setLoading(false);
            }
        }

        void loadWatchlist();

        return () => {
            cancelled = true;
        };
    }, []);

    const handleAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        setAdding(true);
        setError("");
        setSearchResults(null);

        const res = await fetch("/api/watchlist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query }),
        });

        const data = await res.json();
        setAdding(false);

        if (data.multiple) {
            setSearchResults(data.results);
            return;
        }

        if (res.ok) {
            setQuery("");
            fetchWatchlist();
        } else {
            setError(data.error || "Failed to add game.");
        }
    };

    const handleAddByAppId = async (appId: string) => {
        setAdding(true);
        setError("");
        setSearchResults(null);

        const res = await fetch("/api/watchlist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: appId }),
        });

        setAdding(false);
        if (res.ok) {
            setQuery("");
            fetchWatchlist();
        } else {
            const data = await res.json();
            setError(data.error || "Failed to add game.");
        }
    };

    const handleRemove = async (appId: string) => {
        if (!confirm("Remove this game from watchlist?")) return;

        await fetch(`/api/watchlist/${appId}`, { method: "DELETE" });
        fetchWatchlist();
    };

    const formatPrice = (kopecks: number | null) => {
        if (kopecks === null) return "—";
        return `${Math.round(kopecks / 100)} ₽`;
    };

    if (loading) return <div className="text-zinc-400 flex items-center gap-2"><Loader2 className="animate-spin" /> Loading watchlist...</div>;

    return (
        <div className="space-y-8">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Watchlist</h2>
                <p className="text-zinc-400 mt-2">Track Steam games for discount notifications.</p>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                <form onSubmit={handleAdd} className="p-4 border-b border-zinc-800 flex flex-col md:flex-row gap-4 items-end">
                    <div className="flex-1">
                        <label className="block text-sm font-medium text-zinc-300">Game name or App ID</label>
                        <input
                            type="text"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            className="mt-1 block w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                            placeholder="e.g. Cyberpunk 2077 or 1091500"
                            required
                        />
                    </div>
                    <button
                        type="submit"
                        disabled={adding}
                        className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 shrink-0"
                    >
                        {adding ? <Loader2 className="animate-spin mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
                        Add to Watchlist
                    </button>
                </form>

                {error && <div className="p-4 bg-red-900/50 text-red-400 border-b border-zinc-800 text-sm font-medium">{error}</div>}

                {searchResults && (
                    <div className="p-4 border-b border-zinc-800 bg-zinc-950/50">
                        <p className="text-sm text-zinc-300 mb-3">Multiple games found. Select one:</p>
                        <div className="space-y-2">
                            {searchResults.map(r => (
                                <button
                                    key={r.appId}
                                    onClick={() => handleAddByAppId(r.appId)}
                                    className="block w-full text-left px-3 py-2 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-100 hover:border-indigo-500 transition-colors text-sm"
                                >
                                    {r.name} <span className="text-zinc-500">({r.appId})</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                <div className="divide-y divide-zinc-800">
                    {games.length === 0 ? (
                        <div className="p-8 text-center text-zinc-500">Watchlist is empty. Add a game above.</div>
                    ) : (
                        games.map(g => {
                            const latest = g.prices[0];
                            return (
                                <div key={g.id} className="p-4 flex items-center justify-between hover:bg-zinc-800/20 transition-colors">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <h4 className="font-semibold text-zinc-100 truncate">{g.name}</h4>
                                            {g.lastDiscountPct > 0 && (
                                                <span className="text-xs font-medium text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full shrink-0">
                                                    -{g.lastDiscountPct}%
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-sm text-zinc-400 mt-1 flex flex-wrap gap-x-4 gap-y-1">
                                            <span>App: {g.appId}</span>
                                            {latest && (
                                                <>
                                                    <span>RU: {formatPrice(latest.priceRuFinal)}</span>
                                                    {latest.priceKzInRub !== null && <span>KZ: ~{latest.priceKzInRub} ₽</span>}
                                                    {latest.platiPriceRub !== null && <span>Plati: {formatPrice(latest.platiPriceRub)}</span>}
                                                </>
                                            )}
                                            <span>Added: {new Date(g.addedAt).toLocaleDateString("ru-RU")}</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center space-x-2 shrink-0 ml-4">
                                        <a
                                            href={`https://store.steampowered.com/app/${g.appId}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="p-2 text-zinc-400 hover:text-blue-400 hover:bg-zinc-800 rounded-md transition-colors"
                                            title="Open in Steam"
                                        >
                                            <ExternalLink size={18} />
                                        </a>
                                        <button
                                            onClick={() => handleRemove(g.appId)}
                                            className="p-2 text-zinc-400 hover:text-red-400 hover:bg-zinc-800 rounded-md transition-colors"
                                            title="Remove from Watchlist"
                                        >
                                            <Trash2 size={18} />
                                        </button>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
}
