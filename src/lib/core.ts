// FILE: src/lib/core.ts
// VERSION: 1.8.1
// START_MODULE_CONTRACT
//   PURPOSE: Orchestrates the monitoring logic: diffs games, formats messages, updates DB
//   SCOPE: Polls users, formats Telegram HTML payloads (incl. delisted game and bulk-purchase digest
//          fallbacks), tracks and alerts on a user's consecutive per-poll failures
//   DEPENDS: M-DB, M-STEAM, M-TG, M-PRICECARD, M-USERHEALTH
//   LINKS: M-CORE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   pollAllUsers — Run the main background monitoring cycle; counts, alerts once on, and clears a user's consecutive poll failures
//   notifyNewGame — Send one new-game notification and confirm it in the database
//   buildNewGameNotification — Resolve regional details and format the new-game message
//   resolveGameName — Resolve only a game's display name (no ProtonDB, no CBR) for the bulk-purchase digest
//   formatBundleDigestMessage — Format a single digest message for a bulk purchase
//   formatGameMessage — Generate HTML string from Steam data
//   formatRuUnavailableKzGameMessage — Generate HTML string when RU is unavailable but KZ details exist
//   formatDelistedGameMessage — Generate HTML for delisted/unavailable games with SteamDB link
//   sendTestMessage — Format and send a fake test notification
//   stripSecrets — Remove known secret values from text before it is stored or sent
// END_MODULE_MAP

import { prisma } from "./db";
import { getOwnedGames, getAppDetails, getAppNameFallback, SteamAppDetails, getCompatibilityText, detectFamilySharing } from "./steam";
import { formatFamilySharing } from "./pricecard";
import { sendTelegramMessage } from "./telegram";
import { getKztRate, convertKztToRub } from "./cbr";
import { USER_FAILURE_ALERT_THRESHOLD } from "./userHealth";

export const NOTIFY_RETRY_MAX_AGE_HOURS = 72;
export const DIGEST_THRESHOLD = 5; // more than five new games in one cycle — send a digest instead of individual cards
const DIGEST_MAX_ROWS = 20;
// Re-exported from userHealth.ts (not defined here) so the client-side users page can import the
// same threshold without pulling this module's Prisma/Steam/Telegram imports into its bundle —
// see userHealth.ts for the full reasoning. `===` below is deliberate — see START_BLOCK_TRACK_USER_FAILURE.
export { USER_FAILURE_ALERT_THRESHOLD };
const USER_FAILURE_STORED_ERROR_MAX_LENGTH = 500; // bounds what a Steam error body can grow the DB row to
const USER_FAILURE_ALERT_ERROR_MAX_LENGTH = 200; // keeps the Telegram alert body short and readable

export async function pollAllUsers() {
    console.log("[M-CORE] Starting pollAllUsers cycle...");
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings || !settings.steamApiKey || !settings.telegramToken || !settings.telegramChatId) {
        console.warn("[M-CORE] Missing settings. Polling aborted.");
        return;
    }

    const users = await prisma.user.findMany({ include: { games: true } });

    for (const user of users) {
        try {
            // START_BLOCK_RETRY_PENDING_NOTIFICATIONS
            // A game can exist with notifiedAt: null when a previous cycle created the row but
            // failed to confirm delivery (Steam error, Telegram refusal, process crash). Retry it
            // here, before diffing for new games, so a stuck notification is not silently dropped.
            const retryFloor = new Date(Date.now() - NOTIFY_RETRY_MAX_AGE_HOURS * 60 * 60 * 1000);
            const pending = await prisma.game.findMany({ where: { userId: user.id, notifiedAt: null } });

            for (const game of pending) {
                if (game.discoveredAt < retryFloor) {
                    console.warn(`[M-CORE][RETRY_PENDING] Giving up on ${game.appId} for ${user.name} (older than ${NOTIFY_RETRY_MAX_AGE_HOURS}h)`);
                    await prisma.game.update({ where: { id: game.id }, data: { notifiedAt: new Date() } });
                    continue;
                }
                // One poisoned row (Steam rejects, Prisma update fails, etc.) must not abort the
                // rest of this user's pending games or the new-games diff below it: notifiedAt
                // stays null, so the 72h window bounds how long a permanently broken game keeps
                // being retried instead of starving the rest of this user's monitoring forever.
                try {
                    await notifyNewGame(game.id, game.appId, user, settings);
                } catch (retryErr) {
                    console.error(`[M-CORE][RETRY_PENDING] Failed to retry ${game.appId} for ${user.name}:`, retryErr);
                }
            }
            // END_BLOCK_RETRY_PENDING_NOTIFICATIONS

            const ownedGames = await getOwnedGames(user.steamId, settings.steamApiKey);

            // START_BLOCK_CLEAR_USER_FAILURE
            // Steam answered this cycle: whatever was broken (private profile, revoked key,
            // transient outage) is not broken right now. Only write when there is something to
            // clear — an always-on write would mean every healthy poll touches this user's row.
            if ((user.consecutiveFailures ?? 0) > 0) {
                await prisma.user.update({
                    where: { id: user.id },
                    data: { consecutiveFailures: 0, lastError: null, lastErrorAt: null },
                });
            }
            // END_BLOCK_CLEAR_USER_FAILURE

            const dbGameIds = new Set(user.games.map(g => g.appId));

            const newGames = ownedGames.filter(g => !dbGameIds.has(String(g.appid)));

            // Anti-spam guard for the first sync: 0 games in the DB means the user was just
            // added, so their whole library reads as "new" — expected silence, not a bundle.
            const isFirstSync = dbGameIds.size === 0;
            // A bulk purchase (bundle, sale) is the most interesting event of all, and used to
            // drown in the same silence as a first sync. Instead of one card per game, this
            // cycle gets a single digest below.
            const isBulkPurchase = !isFirstSync && newGames.length > DIGEST_THRESHOLD;

            const createdGames: { id: number; appId: string }[] = [];

            for (const newGame of newGames) {
                const appIdStr = String(newGame.appid);

                const created = await prisma.game.create({
                    data: {
                        appId: appIdStr,
                        playtimeForever: newGame.playtime_forever || 0,
                        userId: user.id,
                        // First sync needs no message at all, so it is born already notified. A bulk
                        // purchase still needs its digest confirmed delivered before it can be marked
                        // notified — it starts null like any ordinary new game and is corrected below,
                        // never stamped ahead of the send the way a naive "born notified" would.
                        notifiedAt: isFirstSync ? new Date() : null,
                    },
                });

                createdGames.push({ id: created.id, appId: appIdStr });

                if (!isFirstSync && !isBulkPurchase) {
                    // Same isolation as the retry loop above: one game's failure must not stop
                    // the rest of this batch from being created and notified this cycle.
                    try {
                        await notifyNewGame(created.id, appIdStr, user, settings);
                    } catch (notifyErr) {
                        console.error(`[M-CORE] Failed to process app ${appIdStr} for user ${user.name}:`, notifyErr);
                    }
                }
            }

            if (isBulkPurchase) {
                // START_BLOCK_BULK_PURCHASE_DIGEST
                // One digest instead of one card per game. Isolated in its own try/catch like every
                // other notify call in this function, so a broken digest cannot abort the rest of the
                // poll cycle. On failure every game in this batch is left with notifiedAt: null (it
                // was never stamped ahead of the send), so the retry loop above delivers the same
                // batch as individual cards next cycle — worse than a digest, far better than silence.
                try {
                    const digestGames: { appId: string; name: string }[] = [];
                    for (const g of createdGames) {
                        // A digest is a list of names: one game's name lookup failing must not
                        // sink the whole batch back to slow individual retries. A fallback label
                        // is a far smaller loss than the entire digest.
                        try {
                            const name = await resolveGameName(g.appId);
                            digestGames.push({ appId: g.appId, name });
                        } catch (nameErr) {
                            console.error(`[M-CORE][BULK_DIGEST] Failed to resolve name for ${g.appId}:`, nameErr);
                            digestGames.push({ appId: g.appId, name: `App ${g.appId}` });
                        }
                    }

                    const html = formatBundleDigestMessage(user.name, digestGames);
                    const sent = await sendTelegramMessage(html, settings.telegramChatId, settings.telegramToken);

                    if (sent) {
                        for (const g of createdGames) {
                            await prisma.game.update({ where: { id: g.id }, data: { notifiedAt: new Date() } });
                        }
                        await prisma.messageHistory.create({
                            data: { userName: user.name, gameName: `Дайджест: ${newGames.length} игр`, isTest: false },
                        });
                    } else {
                        console.warn(`[M-CORE][BULK_DIGEST] Telegram refused the digest for ${user.name}, batch stays unnotified for retry`);
                    }
                } catch (digestErr) {
                    console.error(`[M-CORE][BULK_DIGEST] Failed to build or send digest for ${user.name}:`, digestErr);
                }
                // END_BLOCK_BULK_PURCHASE_DIGEST
            }

            if (isFirstSync && newGames.length > 0) {
                console.log(`[M-CORE] First sync for ${user.name}: silently added ${newGames.length} games.`);
            }
        } catch (err) {
            // START_BLOCK_TRACK_USER_FAILURE
            // A private profile or a revoked API key must not look like "nobody bought anything":
            // this is the one place a per-user poll failure gets counted, stored, and — once —
            // announced, instead of only ever reaching console.error. Wrapped in its own try: a
            // DB hiccup or Telegram error while recording THIS user's failure must not throw out
            // of the outer for-loop and abort polling for every user after them — the same
            // per-user isolation the retry and new-games loops already give the happy path.
            try {
                const rawMessage = err instanceof Error ? err.message : String(err);
                // Defense in depth: nothing on this path is expected to carry a secret today
                // (getOwnedGames' own throw never does, and the Steam HTTP gateway redacts URLs
                // before it ever logs or rethrows one), but this message is stored in the DB and
                // sent to Telegram, so any occurrence of a live secret is stripped before either.
                const safeMessage = stripSecrets(rawMessage, [settings.steamApiKey, settings.telegramToken]);
                const failures = (user.consecutiveFailures ?? 0) + 1;

                await prisma.user.update({
                    where: { id: user.id },
                    data: {
                        consecutiveFailures: failures,
                        lastErrorAt: new Date(),
                        lastError: safeMessage.slice(0, USER_FAILURE_STORED_ERROR_MAX_LENGTH),
                    },
                });

                console.error(`[M-CORE][TRACK_USER_FAILURE] ${user.name} failed ${failures} time(s):`, err);

                // Exactly `===`, never `>=`: this fires once per broken-profile episode. `>=` would
                // re-fire on every remaining cycle for as long as the profile stays broken — a
                // message every fifteen minutes, forever. If this one send attempt is refused by
                // Telegram, it is not retried on a later cycle: the users-page marker (consecutive
                // failures past the same threshold) already gives a durable, delivery-independent
                // signal, so a dropped alert degrades to "still visible in the UI", not to silence.
                if (failures === USER_FAILURE_ALERT_THRESHOLD) {
                    const html = `⚠️ <b>Мониторинг ${user.name} не работает</b>\n\n`
                        + `Три проверки подряд закончились ошибкой:\n<code>${safeMessage.slice(0, USER_FAILURE_ALERT_ERROR_MAX_LENGTH)}</code>\n\n`
                        + `Обычно это закрытый профиль Steam или отозванный API-ключ. Пока не починится, о новых играх этого человека сообщений не будет.`;
                    const alerted = await sendTelegramMessage(html, settings.telegramChatId, settings.telegramToken);
                    if (!alerted) {
                        console.warn(`[M-CORE][TRACK_USER_FAILURE] Telegram refused the failure alert for ${user.name}; the users page marker is the fallback signal`);
                    }
                }
            } catch (trackErr) {
                console.error(`[M-CORE][TRACK_USER_FAILURE] Failed to record/alert the failure for ${user.name}:`, trackErr);
            }
            // END_BLOCK_TRACK_USER_FAILURE
        }
    }
}

// START_CONTRACT: stripSecrets
//   PURPOSE: Remove known secret values from text before it is stored or sent anywhere
//   INPUTS: { text: string, secrets: (string | undefined)[] — values that must never reach storage or Telegram }
//   OUTPUTS: { string — text with every occurrence of a non-empty secret replaced by "***" }
//   SIDE_EFFECTS: none
//   LINKS: M-CORE
// END_CONTRACT: stripSecrets
function stripSecrets(text: string, secrets: (string | undefined)[]): string {
    let safe = text;
    for (const secret of secrets) {
        if (secret) safe = safe.split(secret).join("***");
    }
    return safe;
}

// START_CONTRACT: notifyNewGame
//   PURPOSE: Send one new-game notification and confirm it in the database
//   INPUTS: { gameRowId: number, appId: string, user: { id: number; name: string }, settings: Settings }
//   OUTPUTS: { Promise<boolean> - true when Telegram accepted the message }
//   SIDE_EFFECTS: HTTP to Steam and Telegram; updates Game.notifiedAt and inserts MessageHistory
//   LINKS: M-CORE, M-TG
// END_CONTRACT: notifyNewGame
async function notifyNewGame(
    gameRowId: number,
    appId: string,
    user: { id: number; name: string },
    settings: { telegramChatId: string; telegramToken: string },
): Promise<boolean> {
    const { html, imageUrl, gameName } = await buildNewGameNotification(appId, user.name);

    const sent = await sendTelegramMessage(html, settings.telegramChatId, settings.telegramToken, imageUrl);
    if (!sent) {
        console.warn(`[M-CORE][notifyNewGame] Telegram refused ${appId} for ${user.name}, will retry next cycle`);
        return false;
    }

    await prisma.game.update({ where: { id: gameRowId }, data: { notifiedAt: new Date() } });
    await prisma.messageHistory.create({ data: { userName: user.name, gameName, isTest: false } });
    return true;
}

// START_CONTRACT: buildNewGameNotification
//   PURPOSE: Resolve regional details and format the new-game message
//   INPUTS: { appId: string, userName: string }
//   OUTPUTS: { Promise<{ html: string, imageUrl?: string, gameName: string }> }
//   SIDE_EFFECTS: HTTP to Steam (RU → KZ → global → SteamSpy cascade) and CBR (KZ price conversion)
//   LINKS: M-CORE, M-STEAM, M-CBR
// END_CONTRACT: buildNewGameNotification
async function buildNewGameNotification(
    appId: string,
    userName: string,
): Promise<{ html: string; imageUrl?: string; gameName: string }> {
    const detailsRu = await getAppDetails(appId, 'ru');

    if (!detailsRu) {
        // START_BLOCK_REGION_FALLBACK
        // If RU is blocked, prefer KZ before no-cc fallback: no-cc often resolves like RU
        // from this deployment environment and can hide games that are available in KZ.
        console.warn(`[M-CORE] App ${appId} unavailable in RU for ${userName}, trying KZ...`);
        const detailsKz = await getAppDetails(appId, 'kz');

        if (detailsKz) {
            console.log(`[M-CORE] App ${appId} found in KZ (region-locked in RU)`);
            const protonTier = await getCompatibilityText(appId);

            let kzPriceRub: number | undefined;
            if (detailsKz.price_overview) {
                const rate = await getKztRate();
                kzPriceRub = convertKztToRub(detailsKz.price_overview.final, rate);
            }

            const html = formatRuUnavailableKzGameMessage(userName, detailsKz, protonTier, appId, false, kzPriceRub);
            return { html, imageUrl: detailsKz.header_image, gameName: detailsKz.name };
        }

        // Second try: get details without region (game may be globally visible, not delisted)
        console.warn(`[M-CORE] App ${appId} unavailable in RU/KZ for ${userName}, trying global...`);
        const globalDetails = await getAppDetails(appId, '');

        if (globalDetails) {
            // Game exists globally but not in RU — send full notification
            console.log(`[M-CORE] App ${appId} found globally (region-locked in RU)`);
            const protonTier = await getCompatibilityText(appId);
            const html = formatGameMessage(userName, globalDetails, null, protonTier, appId, false);
            return { html, imageUrl: globalDetails.header_image, gameName: globalDetails.name };
        }

        // Game truly unavailable — use SteamSpy fallback for name
        console.warn(`[M-CORE] App ${appId} unavailable globally, using SteamSpy fallback`);
        const fallbackName = await getAppNameFallback(appId);
        const gameName = fallbackName || `Unknown App ${appId}`;
        const html = formatDelistedGameMessage(userName, gameName, appId);
        return { html, gameName: `${gameName} (unavailable)` };
        // END_BLOCK_REGION_FALLBACK
    }

    const detailsKz = await getAppDetails(appId, 'kz');
    const protonTier = await getCompatibilityText(appId);

    let kzPriceRub: number | undefined;
    if (detailsKz?.price_overview) {
        const rate = await getKztRate();
        kzPriceRub = convertKztToRub(detailsKz.price_overview.final, rate);
    }

    const html = formatGameMessage(userName, detailsRu, detailsKz, protonTier, appId, false, kzPriceRub);
    return { html, imageUrl: detailsRu.header_image, gameName: detailsRu.name };
}

// START_CONTRACT: resolveGameName
//   PURPOSE: Resolve only a game's display name for the bulk-purchase digest, without the cost or
//            failure surface of a full notification build
//   INPUTS: { appId: string }
//   OUTPUTS: { Promise<string> - first name found across RU, KZ, global Steam details, or the
//              SteamSpy fallback; `App <appId>` if none resolve }
//   SIDE_EFFECTS: HTTP to Steam (RU -> KZ -> global -> SteamSpy cascade); deliberately no
//                 getCompatibilityText (ProtonDB) and no CBR rate lookup — a digest never shows
//                 either, so a ProtonDB/CBR outage must not be able to block name resolution
//   LINKS: M-CORE, M-STEAM
// END_CONTRACT: resolveGameName
async function resolveGameName(appId: string): Promise<string> {
    const detailsRu = await getAppDetails(appId, 'ru');
    if (detailsRu) return detailsRu.name;

    const detailsKz = await getAppDetails(appId, 'kz');
    if (detailsKz) return detailsKz.name;

    const globalDetails = await getAppDetails(appId, '');
    if (globalDetails) return globalDetails.name;

    const fallbackName = await getAppNameFallback(appId);
    return fallbackName || `App ${appId}`;
}

// START_CONTRACT: formatBundleDigestMessage
//   PURPOSE: Announce a bulk purchase as one message instead of staying silent
//   INPUTS: { userName: string, games: { appId: string; name: string }[] }
//   OUTPUTS: { string - Telegram HTML within the 4096 char limit }
//   SIDE_EFFECTS: none
//   LINKS: M-CORE
// END_CONTRACT: formatBundleDigestMessage
export function formatBundleDigestMessage(userName: string, games: { appId: string; name: string }[]): string {
    const shown = games.slice(0, DIGEST_MAX_ROWS);
    const hidden = games.length - shown.length;

    let msg = `🎁 <b>${userName}: сразу ${games.length} новых игр!</b>\n\n`;
    for (const game of shown) {
        msg += `• <a href="https://store.steampowered.com/app/${game.appId}">${game.name}</a>\n`;
    }
    if (hidden > 0) msg += `\n…и ещё ${hidden}\n`;
    msg += `\nПодробности по любой из них: <code>/price название</code>`;

    return msg;
}

export function formatGameMessage(
    userName: string,
    details: SteamAppDetails,
    kzDetails: SteamAppDetails | null,
    protonTier: string | null,
    appId: string,
    isTest: boolean,
    kzPriceRub?: number,
): string {
    const isFree = details.is_free;
    let priceText = "Неизвестно";

    if (isFree) {
        priceText = "Бесплатно";
    } else if (details.price_overview) {
        priceText = details.price_overview.final_formatted;
        if (kzDetails && kzDetails.price_overview && kzPriceRub !== undefined) {
            priceText += ` / ~${kzPriceRub} ₽ (${kzDetails.price_overview.final_formatted})`;
        }
    }

    const targetCategories = ["Single-player", "Multi-player", "Co-op", "PvP", "Cross-Platform Multiplayer", "Online PvP", "Online Co-op", "Для одного игрока", "Для нескольких игроков", "Кооперативная игра"];
    const modesArray = details.categories
        ?.filter(c => targetCategories.some(tc => c.description.includes(tc)))
        .map(c => c.description);

    const modes = modesArray && modesArray.length > 0 ? modesArray.join(", ") : "Не указано";

    const hasFamilySharing = formatFamilySharing(detectFamilySharing(details));

    let msg = ``;
    if (isTest) {
        msg += `<b>[ТЕСТ]</b>\n\n`;
    }

    msg += `🚨 <b>Новая игра у ${userName}!</b>\n\n`;
    msg += `🎮 <b><a href="https://store.steampowered.com/app/${appId}">${details.name}</a></b>\n\n`;
    msg += `💰 <b>Цена:</b> ${priceText}\n`;
    msg += `🎯 <b>Режимы:</b> ${modes}\n`;
    msg += `👨‍👩‍👦 <b>Семейная библиотека:</b> ${hasFamilySharing}\n`;

    if (details.metacritic) {
        msg += `⭐ <b>Metacritic:</b> <a href="${details.metacritic.url}">${details.metacritic.score}/100</a>\n`;
    }

    const protonText = protonTier ? `${protonTier.charAt(0).toUpperCase() + protonTier.slice(1)}` : `Неизвестно`;
    msg += `🐧 <b>Steam Deck / Linux:</b> <a href="https://www.protondb.com/app/${appId}">${protonText}</a>\n\n`;

    if (details.short_description) {
        msg += `📝 <i>${details.short_description}</i>`;
    }

    return msg;
}

// START_CONTRACT: formatRuUnavailableKzGameMessage
//   PURPOSE: Generate HTML notification when Steam RU is unavailable but KZ details exist
//   INPUTS: { userName: string, detailsKz: SteamAppDetails, protonTier: string | null, appId: string, isTest: boolean, kzPriceRub?: number }
//   OUTPUTS: { string — HTML message }
//   SIDE_EFFECTS: none
//   LINKS: M-CORE
// END_CONTRACT: formatRuUnavailableKzGameMessage
export function formatRuUnavailableKzGameMessage(
    userName: string,
    detailsKz: SteamAppDetails,
    protonTier: string | null,
    appId: string,
    isTest: boolean,
    kzPriceRub?: number,
): string {
    // START_BLOCK_FORMAT_RU_UNAVAILABLE_KZ
    let kzPriceText = "Неизвестно";
    if (detailsKz.is_free) {
        kzPriceText = "Бесплатно";
    } else if (detailsKz.price_overview) {
        kzPriceText = detailsKz.price_overview.final_formatted;
        if (kzPriceRub !== undefined) {
            kzPriceText += ` / ~${kzPriceRub} ₽`;
        }
    }

    const targetCategories = ["Single-player", "Multi-player", "Co-op", "PvP", "Cross-Platform Multiplayer", "Online PvP", "Online Co-op", "Для одного игрока", "Для нескольких игроков", "Кооперативная игра"];
    const modesArray = detailsKz.categories
        ?.filter(c => targetCategories.some(tc => c.description.includes(tc)))
        .map(c => c.description);

    const modes = modesArray && modesArray.length > 0 ? modesArray.join(", ") : "Не указано";

    const hasFamilySharing = formatFamilySharing(detectFamilySharing(detailsKz));

    let msg = ``;
    if (isTest) {
        msg += `<b>[ТЕСТ]</b>\n\n`;
    }

    msg += `🚨 <b>Новая игра у ${userName}!</b>\n\n`;
    msg += `🎮 <b><a href="https://store.steampowered.com/app/${appId}">${detailsKz.name}</a></b>\n\n`;
    msg += `💰 <b>Цена / доступность:</b>\n`;
    msg += `🇷🇺 <b>RU:</b> Недоступно\n`;
    msg += `🇰🇿 <b>KZ:</b> ${kzPriceText}\n`;
    msg += `🎯 <b>Режимы:</b> ${modes}\n`;
    msg += `👨‍👩‍👦 <b>Семейная библиотека:</b> ${hasFamilySharing}\n`;

    if (detailsKz.metacritic) {
        msg += `⭐ <b>Metacritic:</b> <a href="${detailsKz.metacritic.url}">${detailsKz.metacritic.score}/100</a>\n`;
    }

    const protonText = protonTier ? `${protonTier.charAt(0).toUpperCase() + protonTier.slice(1)}` : `Неизвестно`;
    msg += `🐧 <b>Steam Deck / Linux:</b> <a href="https://www.protondb.com/app/${appId}">${protonText}</a>\n\n`;

    if (detailsKz.short_description) {
        msg += `📝 <i>${detailsKz.short_description}</i>`;
    }

    // END_BLOCK_FORMAT_RU_UNAVAILABLE_KZ
    return msg;
}

// START_CONTRACT: formatDelistedGameMessage
//   PURPOSE: Generate HTML notification for an unavailable game
//   INPUTS: { userName: string, gameName: string, appId: string }
//   OUTPUTS: { string — HTML message }
//   SIDE_EFFECTS: none
//   LINKS: M-CORE
// END_CONTRACT: formatDelistedGameMessage
export function formatDelistedGameMessage(
    userName: string,
    gameName: string,
    appId: string,
): string {
    // START_BLOCK_FORMAT_DELISTED
    let msg = ``;
    msg += `🚨 <b>Новая игра у ${userName}!</b>\n\n`;
    msg += `🎮 <b><a href="https://store.steampowered.com/app/${appId}">${gameName}</a></b>\n\n`;
    msg += `⚠️ <i>Информация об игре недоступна (возможно, не продаётся в вашем регионе)</i>\n\n`;
    msg += `🔍 <a href="https://steamdb.info/app/${appId}/info/">Посмотреть на SteamDB</a>`;
    // END_BLOCK_FORMAT_DELISTED
    return msg;
}

export async function sendTestMessage(userId: number) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error("User not found");

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) throw new Error("Settings not configured");

    const TEST_APP_IDS = ["730", "570", "1091500", "2050650", "1086940", "1172470", "400", "440", "252490", "1245620", "236430"];
    const TEST_APP_ID = TEST_APP_IDS[Math.floor(Math.random() * TEST_APP_IDS.length)];
    let detailsRu: SteamAppDetails | null = null;
    let detailsKz: SteamAppDetails | null = null;
    let protonTier: string | null = null;

    detailsRu = await getAppDetails(TEST_APP_ID, 'ru');
    if (!detailsRu) {
        detailsRu = { name: "Test Game (API Failure Fallback)" };
    }
    detailsKz = await getAppDetails(TEST_APP_ID, 'kz');
    protonTier = await getCompatibilityText(TEST_APP_ID);

    let kzPriceRub: number | undefined;
    if (detailsKz?.price_overview) {
        const rate = await getKztRate();
        kzPriceRub = convertKztToRub(detailsKz.price_overview.final, rate);
    }

    const html = formatGameMessage(user.name, detailsRu, detailsKz, protonTier, TEST_APP_ID, true, kzPriceRub);
    await sendTelegramMessage(html, settings.telegramChatId, settings.telegramToken, detailsRu.header_image);

    await prisma.messageHistory.create({
        data: {
            userName: user.name,
            gameName: detailsRu.name,
            isTest: true,
        }
    });
}

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.2.0 — Added KZ regional fallback when RU Store details are unavailable]
//   LAST_CHANGE_2: [v1.3.0 — Use official Steam Deck compatibility plus ProtonDB tier in notifications]
//   LAST_CHANGE_3: [v1.4.0 - Store owned-game playtime for achievement candidate detection]
//   LAST_CHANGE_4: [v1.5.0 - Reuse shared family sharing detection; missing categories now report "Нет данных" instead of a false "Недоступно"]
//   LAST_CHANGE_5: [v1.6.0 - Confirm notifications before marking a game known; retry unnotified games for 72h]
//   LAST_CHANGE_6: [v1.6.1 - Isolate one game's notify failure per-item in both the retry and new-games loops so it cannot starve the rest of a user's cycle]
//   LAST_CHANGE_7: [v1.7.0 - Replace silent bulk-purchase suppression with a single digest message; first sync (0 known games) stays the only silent case]
//   LAST_CHANGE_8: [v1.7.1 - Resolve digest names via a name-only cascade instead of the full notification builder, so a ProtonDB/CBR failure can no longer abort an otherwise-resolvable digest; isolate each game's name lookup so one unresolvable title falls back instead of sinking the batch]
//   LAST_CHANGE_9: [v1.8.0 - A per-user poll failure now counts (User.consecutiveFailures), is stored with its bounded, secret-stripped message, is cleared on the next successful poll, and triggers exactly one Telegram alert at USER_FAILURE_ALERT_THRESHOLD (=== not >=) instead of only reaching console.error]
//   LAST_CHANGE_10: [v1.8.1 - USER_FAILURE_ALERT_THRESHOLD moved to userHealth.ts (re-exported here) so the client-side users-page marker imports the same constant instead of a hand-duplicated literal]
// END_CHANGE_SUMMARY
