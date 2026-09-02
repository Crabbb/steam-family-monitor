// FILE: src/app/layout.tsx
// VERSION: 1.0.1
// START_MODULE_CONTRACT
//   PURPOSE: Root application shell with global metadata, styles, and navigation
//   SCOPE: Defines the shared sidebar layout for all App Router pages
//   DEPENDS: M-UI
//   LINKS: M-UI
// END_MODULE_CONTRACT

import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";
import { Activity, Users, Settings, History, Eye } from "lucide-react";

export const metadata: Metadata = {
  title: "Steam Monitor",
  description: "Monitor Steam libraries and send Telegram notifications",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-zinc-950 text-zinc-50 flex h-screen overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col">
          <div className="h-16 flex items-center px-6 border-b border-zinc-800">
            <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
              Steam Monitor
            </h1>
          </div>
          <nav className="flex-1 p-4 space-y-2">
            <NavItem href="/" icon={<Activity size={20} />} label="Dashboard" />
            <NavItem href="/users" icon={<Users size={20} />} label="Users" />
            <NavItem href="/history" icon={<History size={20} />} label="History" />
            <NavItem href="/watchlist" icon={<Eye size={20} />} label="Watchlist" />
            <NavItem href="/settings" icon={<Settings size={20} />} label="Settings" />
          </nav>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto bg-zinc-950">
          <div className="max-w-6xl mx-auto p-8">
            {children}
          </div>
        </main>
      </body>
    </html>
  );
}

function NavItem({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <Link
      href={href}
      className="flex items-center space-x-3 px-3 py-2.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/50 transition-colors"
    >
      {icon}
      <span className="font-medium">{label}</span>
    </Link>
  );
}
