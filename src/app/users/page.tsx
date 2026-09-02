// FILE: src/app/users/page.tsx
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Monitored Users UI 
//   SCOPE: Read, Add, Delete users and send tests
//   DEPENDS: M-API
//   LINKS: M-UI
// END_MODULE_CONTRACT

"use client";

import { useCallback, useEffect, useState } from "react";
import { UserPlus, Trash2, Send, Loader2 } from "lucide-react";

interface User {
    id: number;
    steamId: string;
    name: string;
    _count: { games: number };
}

export default function UsersPage() {
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [newUser, setNewUser] = useState({ name: "", steamId: "" });
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState("");

    const fetchUsers = useCallback(async () => {
        const res = await fetch("/api/users");
        const data = await res.json();
        setUsers(data);
        setLoading(false);
    }, []);

    useEffect(() => {
        let cancelled = false;

        async function loadUsers() {
            const res = await fetch("/api/users");
            const data = await res.json();
            if (!cancelled) {
                setUsers(data);
                setLoading(false);
            }
        }

        void loadUsers();

        return () => {
            cancelled = true;
        };
    }, []);

    const handleAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        setAdding(true);
        setError("");

        const res = await fetch("/api/users", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(newUser),
        });

        setAdding(false);
        if (res.ok) {
            setNewUser({ name: "", steamId: "" });
            fetchUsers();
        } else {
            const data = await res.json();
            setError(data.error || "Failed to add user.");
        }
    };

    const handleDelete = async (id: number) => {
        if (!confirm("Are you sure you want to remove this user? This will also wipe their game state tracking.")) return;

        await fetch(`/api/users/${id}`, { method: "DELETE" });
        fetchUsers();
    };

    const handleTest = async (id: number) => {
        const res = await fetch("/api/test-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: id }),
        });
        if (res.ok) {
            alert("Test message sent!");
        } else {
            alert("Failed to send test message.");
        }
    };

    if (loading) return <div className="text-zinc-400 flex items-center gap-2"><Loader2 className="animate-spin" /> Loading users...</div>;

    return (
        <div className="space-y-8">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Monitored Users</h2>
                <p className="text-zinc-400 mt-2">Manage the Steam accounts being tracked for new games.</p>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                <form onSubmit={handleAdd} className="p-4 border-b border-zinc-800 flex flex-col md:flex-row gap-4 items-end">
                    <div className="flex-1">
                        <label className="block text-sm font-medium text-zinc-300">Name / Alias</label>
                        <input
                            type="text"
                            value={newUser.name}
                            onChange={e => setNewUser({ ...newUser, name: e.target.value })}
                            className="mt-1 block w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                            placeholder="e.g. John Doe"
                            required
                        />
                    </div>
                    <div className="flex-1">
                        <label className="block text-sm font-medium text-zinc-300">SteamID 64</label>
                        <input
                            type="text"
                            value={newUser.steamId}
                            onChange={e => setNewUser({ ...newUser, steamId: e.target.value })}
                            className="mt-1 block w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                            placeholder="76561198000000000"
                            required
                        />
                    </div>
                    <button
                        type="submit"
                        disabled={adding}
                        className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 shrink-0"
                    >
                        {adding ? <Loader2 className="animate-spin mr-2 h-4 w-4" /> : <UserPlus className="mr-2 h-4 w-4" />}
                        Add User
                    </button>
                </form>

                {error && <div className="p-4 bg-red-900/50 text-red-400 border-b border-zinc-800 text-sm font-medium">{error}</div>}

                <div className="divide-y divide-zinc-800">
                    {users.length === 0 ? (
                        <div className="p-8 text-center text-zinc-500">No users found. Add one above.</div>
                    ) : (
                        users.map((u) => (
                            <div key={u.id} className="p-4 flex items-center justify-between hover:bg-zinc-800/20 transition-colors">
                                <div>
                                    <h4 className="font-semibold text-zinc-100">{u.name}</h4>
                                    <div className="text-sm text-zinc-400 mt-1 space-x-4">
                                        <span>ID: {u.steamId}</span>
                                        <span>Games: {u._count.games} tracked</span>
                                    </div>
                                </div>
                                <div className="flex items-center space-x-2">
                                    <button
                                        onClick={() => handleTest(u.id)}
                                        className="p-2 text-zinc-400 hover:text-indigo-400 hover:bg-zinc-800 rounded-md transition-colors"
                                        title="Send Test Message"
                                    >
                                        <Send size={18} />
                                    </button>
                                    <button
                                        onClick={() => handleDelete(u.id)}
                                        className="p-2 text-zinc-400 hover:text-red-400 hover:bg-zinc-800 rounded-md transition-colors"
                                        title="Delete User"
                                    >
                                        <Trash2 size={18} />
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
