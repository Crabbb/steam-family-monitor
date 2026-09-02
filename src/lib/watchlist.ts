// FILE: src/lib/watchlist.ts
// VERSION: 2.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Periodic watchlist price check — detects new discounts, records history, sends alerts
//   SCOPE: checkWatchlistPrices() called by cron every 12 hours
//   DEPENDS: M-DB, M-PRICECARD, M-TG
//   LINKS: M-WATCHLIST
// END_MODULE_CONTRACT

import { prisma } from "./db";
import { buildPriceCard, formatWatchlistAlertHtml } from "./pricecard";
import { sendTelegramMessage } from "./telegram";

export async function checkWatchlistPrices(): Promise<void> {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings?.telegramToken || settings.watchlistEnabled === false) {
        console.warn("[M-WATCHLIST] Watchlist disabled or Telegram token missing, skipping watchlist check");
        return;
    }
    const minDiscountPct = settings.watchlistMinDiscountPct || 1;

    const watchedGames = await prisma.watchedGame.findMany();
    if (watchedGames.length === 0) {
        console.log("[M-WATCHLIST] Watchlist is empty, nothing to check");
        return;
    }

    console.log(`[M-WATCHLIST] Checking prices for ${watchedGames.length} watched games...`);

    for (const game of watchedGames) {
        try {
            const card = await buildPriceCard(game.appId);
            if (!card) {
                console.warn(`[M-WATCHLIST] Could not build price card for ${game.appId} (${game.name})`);
                continue;
            }

            // Save price history
            await prisma.priceHistory.create({
                data: {
                    appId: game.appId,
                    priceRuFinal: card.priceRuFinal,
                    priceKzFinal: card.priceKzFinal,
                    discountPct: card.discountPctRu,
                    discountPctKz: card.discountPctKz,
                    priceKzInRub: card.priceKzInRub,
                    platiPriceRub: card.platiPriceRub ? Math.round(card.platiPriceRub * 100) : null,
                    watchedGameId: game.id,
                },
            });

            // START_BLOCK_DETECT_REGIONAL_DISCOUNT
            // A game blocked in RU has no RU price at all, so its RU discount is permanently 0.
            // Treating each region on its own is what makes the watchlist work for those games.
            // Normalize a missing stored value to 0 rather than comparing it raw: `undefined < n`
            // is always false in JS, so a stale client or a select() that drops the column would
            // silently disable that region's branch forever — failing toward silence, which is
            // the worst direction for a monitor. `null` already coerces to 0; this also covers it.
            const lastRu = game.lastDiscountPct ?? 0;
            const lastKz = game.lastDiscountPctKz ?? 0;
            const triggeredRegions: ("RU" | "KZ")[] = [];
            if (lastRu < minDiscountPct && card.discountPctRu >= minDiscountPct) triggeredRegions.push("RU");
            if (lastKz < minDiscountPct && card.discountPctKz >= minDiscountPct) triggeredRegions.push("KZ");
            // END_BLOCK_DETECT_REGIONAL_DISCOUNT

            if (triggeredRegions.length > 0) {
                console.log(`[M-WATCHLIST] Discount detected for ${game.name}: ${triggeredRegions.join(", ")}`);

                // Query historical minimums
                const histMin = await prisma.priceHistory.aggregate({
                    where: { appId: game.appId },
                    _min: { priceRuFinal: true, priceKzInRub: true },
                });

                const html = formatWatchlistAlertHtml(
                    card,
                    histMin._min.priceRuFinal,
                    histMin._min.priceKzInRub,
                    triggeredRegions,
                );

                const chatId = game.chatId === "web" ? settings.telegramChatId : game.chatId;
                await sendTelegramMessage(html, chatId, settings.telegramToken, card.headerImage);
            }

            // Update last known discount for both regions, on every path, so state cannot drift.
            await prisma.watchedGame.update({
                where: { id: game.id },
                data: { lastDiscountPct: card.discountPctRu, lastDiscountPctKz: card.discountPctKz },
            });

        } catch (err) {
            console.error(`[M-WATCHLIST] Error checking ${game.appId} (${game.name}):`, err);
        }

        // Rate-limit: 1s delay between games
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log("[M-WATCHLIST] Price check complete");
}

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v2.1.0 — Added configurable watchlist enablement and discount threshold]
//   LAST_CHANGE_2: [v2.2.0 — Price history rows now also store the KZ discount percent]
//   LAST_CHANGE_3: [v2.2.0 - Trigger alerts per region so RU-blocked games are watchable]
//   LAST_CHANGE_4: [v2.2.0 - Normalize missing lastDiscountPct(Kz) to 0 so an absent value can't silently disable a region]
// END_CHANGE_SUMMARY
