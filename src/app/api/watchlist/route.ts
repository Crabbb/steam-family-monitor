// FILE: src/app/api/watchlist/route.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: GET/POST /api/watchlist
//   SCOPE: List watched games with latest price, add new games to watchlist
//   DEPENDS: M-DB, M-STEAM
//   LINKS: M-API
// END_MODULE_CONTRACT

import { NextResponse } from "next/server";
import { prisma } from "../../../lib/db";
import { searchSteamGames, getAppDetails } from "../../../lib/steam";

function isUniqueConstraintError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export async function GET() {
    const watched = await prisma.watchedGame.findMany({
        include: { prices: { orderBy: { checkedAt: "desc" }, take: 1 } },
        orderBy: { addedAt: "desc" },
    });
    return NextResponse.json(watched);
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const query = body.query?.trim();

        if (!query) {
            return NextResponse.json({ error: "Query is required" }, { status: 400 });
        }

        // Resolve game
        const results = await searchSteamGames(query, 5);
        if (results.length === 0) {
            return NextResponse.json({ error: "No games found" }, { status: 404 });
        }

        // If multiple results and no explicit appId, return options for UI
        if (results.length > 1 && !/^\d+$/.test(query)) {
            // Resolve names for results that don't have them
            const resolved = await Promise.all(
                results.map(async r => {
                    if (r.name) return r;
                    const details = await getAppDetails(r.appId, "ru");
                    return { appId: r.appId, name: details?.name || `App ${r.appId}` };
                })
            );
            return NextResponse.json({ multiple: true, results: resolved });
        }

        // Single result — add to watchlist
        const appId = results[0].appId;
        let name = results[0].name;
        if (!name) {
            const detailsRu = await getAppDetails(appId, "ru");
            if (detailsRu) {
                name = detailsRu.name;
            } else {
                const globalDetails = await getAppDetails(appId, "");
                if (globalDetails) {
                    name = globalDetails.name;
                } else {
                    const kzDetails = await getAppDetails(appId, "kz");
                    name = kzDetails?.name || `App ${appId}`;
                }
            }
        }

        // Use settings chatId for web-added games
        const settings = await prisma.settings.findUnique({ where: { id: 1 } });
        const chatId = settings?.telegramChatId || "web";

        const watched = await prisma.watchedGame.create({
            data: { appId, name, chatId },
        });

        return NextResponse.json(watched);
    } catch (error: unknown) {
        if (isUniqueConstraintError(error)) {
            return NextResponse.json({ error: "Game is already in watchlist" }, { status: 400 });
        }
        console.error("[API] Watchlist POST error:", error);
        return NextResponse.json({ error: "Failed to add game" }, { status: 500 });
    }
}
