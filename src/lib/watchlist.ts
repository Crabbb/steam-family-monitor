// FILE: src/lib/watchlist.ts
// VERSION: 2.1.0
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
                    priceKzInRub: card.priceKzInRub,
                    platiPriceRub: card.platiPriceRub ? Math.round(card.platiPriceRub * 100) : null,
                    watchedGameId: game.id,
                },
            });

            // Check if discount crossed the configured threshold.
            const discountAppeared = game.lastDiscountPct < minDiscountPct && card.discountPctRu >= minDiscountPct;

            if (discountAppeared) {
                console.log(`[M-WATCHLIST] Discount detected for ${game.name}: -${card.discountPctRu}%`);

                // Query historical minimums
                const histMin = await prisma.priceHistory.aggregate({
                    where: { appId: game.appId },
                    _min: { priceRuFinal: true, priceKzInRub: true },
                });

                const html = formatWatchlistAlertHtml(
                    card,
                    histMin._min.priceRuFinal,
                    histMin._min.priceKzInRub,
                );

                const chatId = game.chatId === "web" ? settings.telegramChatId : game.chatId;
                await sendTelegramMessage(html, chatId, settings.telegramToken, card.headerImage);
            }

            // Update last known discount
            await prisma.watchedGame.update({
                where: { id: game.id },
                data: { lastDiscountPct: card.discountPctRu },
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
// END_CHANGE_SUMMARY
