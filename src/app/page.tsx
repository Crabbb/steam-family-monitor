// FILE: src/app/page.tsx
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Main overview dashboard component
//   SCOPE: Display monitored users count, total games recorded
//   DEPENDS: M-DB
//   LINKS: M-UI
// END_MODULE_CONTRACT

import { prisma } from "../lib/db";
import { Users, Gamepad2, Send, Eye, Gift } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const usersCount = await prisma.user.count();
  const gamesCount = await prisma.game.count();
  const msgsCount = await prisma.messageHistory.count();
  const watchCount = await prisma.watchedGame.count();
  const freePromosCount = await prisma.freePromotionNotification.count();

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white tracking-tight">Dashboard</h2>
        <p className="text-zinc-400 mt-2">Overview of Steam monitoring activity.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
        <StatCard
          title="Monitored Users"
          value={usersCount.toString()}
          icon={<Users className="text-blue-400" size={24} />}
        />
        <StatCard
          title="Known Games Tracking"
          value={gamesCount.toString()}
          icon={<Gamepad2 className="text-emerald-400" size={24} />}
        />
        <StatCard
          title="Notifications Sent"
          value={msgsCount.toString()}
          icon={<Send className="text-indigo-400" size={24} />}
        />
        <StatCard
          title="Watched Games"
          value={watchCount.toString()}
          icon={<Eye className="text-amber-400" size={24} />}
        />
        <StatCard
          title="Free Promos Sent"
          value={freePromosCount.toString()}
          icon={<Gift className="text-pink-400" size={24} />}
        />
      </div>
    </div>
  );
}

function StatCard({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-400">{title}</h3>
        {icon}
      </div>
      <p className="text-3xl font-bold text-white mt-4">{value}</p>
    </div>
  );
}
