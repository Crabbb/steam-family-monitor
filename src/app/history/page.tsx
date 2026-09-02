// FILE: src/app/history/page.tsx
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: History Dashboard UI 
//   SCOPE: Display past notifications sent by M-CORE
//   DEPENDS: M-API
//   LINKS: M-UI
// END_MODULE_CONTRACT

"use client";

import { useEffect, useState } from "react";
import { Loader2, Bell } from "lucide-react";

interface Log {
    id: number;
    userName: string;
    gameName: string;
    sentAt: string;
    isTest: boolean;
}

export default function HistoryPage() {
    const [logs, setLogs] = useState<Log[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch("/api/history")
            .then(res => res.json())
            .then(data => {
                setLogs(data);
                setLoading(false);
            });
    }, []);

    if (loading) return <div className="text-zinc-400 flex items-center gap-2"><Loader2 className="animate-spin" /> Loading history...</div>;

    return (
        <div className="space-y-8">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Notification History</h2>
                <p className="text-zinc-400 mt-2">Log of Telegram alerts successfully dispatched.</p>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                <ul className="divide-y divide-zinc-800">
                    {logs.length === 0 ? (
                        <div className="p-8 text-center text-zinc-500">No activity logged yet.</div>
                    ) : (
                        logs.map((log) => (
                            <li key={log.id} className="p-4 flex items-center justify-between hover:bg-zinc-800/20 transition-colors">
                                <div className="flex items-center space-x-4">
                                    <div className={`p-2 rounded-full ${log.isTest ? 'bg-amber-500/10 text-amber-500' : 'bg-emerald-500/10 text-emerald-500'}`}>
                                        <Bell size={20} />
                                    </div>
                                    <div>
                                        <h4 className="font-medium text-zinc-100">
                                            {log.userName} added {log.gameName}
                                        </h4>
                                        {log.isTest && <span className="text-xs font-semibold text-amber-500 mt-1 inline-block">[TEST MESSAGE]</span>}
                                    </div>
                                </div>
                                <div className="text-sm text-zinc-500">
                                    {new Date(log.sentAt).toLocaleString('ru-RU')}
                                </div>
                            </li>
                        ))
                    )}
                </ul>
            </div>
        </div>
    );
}
