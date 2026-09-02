// FILE: src/app/api/watchlist/[appId]/route.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: GET/DELETE /api/watchlist/[appId]
//   SCOPE: Get price history for a game, remove game from watchlist
//   DEPENDS: M-DB
//   LINKS: M-API
// END_MODULE_CONTRACT

import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ appId: string }> }) {
    try {
        const { appId } = await params;
        const history = await prisma.priceHistory.findMany({
            where: { appId },
            orderBy: { checkedAt: "desc" },
            take: 100,
        });
        return NextResponse.json(history);
    } catch {
        return NextResponse.json({ error: "Failed to fetch price history" }, { status: 500 });
    }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ appId: string }> }) {
    try {
        const { appId } = await params;

        // Find all watched game entries for this appId (could be from multiple chats)
        const watched = await prisma.watchedGame.findMany({ where: { appId } });
        if (watched.length === 0) {
            return NextResponse.json({ error: "Game not in watchlist" }, { status: 404 });
        }

        // Delete all entries for this appId (cascade deletes PriceHistory)
        await prisma.watchedGame.deleteMany({ where: { appId } });
        return NextResponse.json({ success: true });
    } catch {
        return NextResponse.json({ error: "Failed to remove from watchlist" }, { status: 500 });
    }
}
