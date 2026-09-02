// FILE: src/lib/core.ts
// VERSION: 1.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Orchestrates the monitoring logic: diffs games, formats messages, updates DB
//   SCOPE: Polls users, formats Telegram HTML payloads (incl. delisted game fallback)
//   DEPENDS: M-DB, M-STEAM, M-TG, M-PRICECARD
//   LINKS: M-CORE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   pollAllUsers — Run the main background monitoring cycle
//   formatGameMessage — Generate HTML string from Steam data
//   formatRuUnavailableKzGameMessage — Generate HTML string when RU is unavailable but KZ details exist
//   formatDelistedGameMessage — Generate HTML for delisted/unavailable games with SteamDB link
//   sendTestMessage — Format and send a fake test notification
// END_MODULE_MAP

import { prisma } from "./db";
import { getOwnedGames, getAppDetails, getAppNameFallback, SteamAppDetails, getCompatibilityText, detectFamilySharing } from "./steam";
import { formatFamilySharing } from "./pricecard";
import { sendTelegramMessage } from "./telegram";
import { getKztRate, convertKztToRub } from "./cbr";

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
            const ownedGames = await getOwnedGames(user.steamId, settings.steamApiKey);
            const dbGameIds = new Set(user.games.map(g => g.appId));

            const newGames = ownedGames.filter(g => !dbGameIds.has(String(g.appid)));

            // Защита от спама: если в БД у пользователя 0 игр, ИЛИ новых игр больше 5 за раз
            // то мы считаем это массовой синхронизацией и не шлем уведомления
            const isFirstSync = dbGameIds.size === 0 || newGames.length > 5;

            for (const newGame of newGames) {
                const appIdStr = String(newGame.appid);

                await prisma.game.create({
                    data: {
                        appId: appIdStr,
                        playtimeForever: newGame.playtime_forever || 0,
                        userId: user.id
                    }
                });

                if (!isFirstSync) {
                    try {
                        const detailsRu = await getAppDetails(appIdStr, 'ru');

                        if (!detailsRu) {
                            // START_BLOCK_REGION_FALLBACK
                            // If RU is blocked, prefer KZ before no-cc fallback: no-cc often resolves like RU
                            // from this deployment environment and can hide games that are available in KZ.
                            console.warn(`[M-CORE] App ${appIdStr} unavailable in RU for ${user.name}, trying KZ...`);
                            const detailsKz = await getAppDetails(appIdStr, 'kz');

                            if (detailsKz) {
                                console.log(`[M-CORE] App ${appIdStr} found in KZ (region-locked in RU)`);
                                const protonTier = await getCompatibilityText(appIdStr);

                                let kzPriceRub: number | undefined;
                                if (detailsKz.price_overview) {
                                    const rate = await getKztRate();
                                    kzPriceRub = convertKztToRub(detailsKz.price_overview.final, rate);
                                }

                                const html = formatRuUnavailableKzGameMessage(user.name, detailsKz, protonTier, appIdStr, false, kzPriceRub);
                                await sendTelegramMessage(html, settings.telegramChatId, settings.telegramToken, detailsKz.header_image);

                                await prisma.messageHistory.create({
                                    data: {
                                        userName: user.name,
                                        gameName: detailsKz.name,
                                        isTest: false,
                                    }
                                });
                                continue;
                            }

                            // Second try: get details without region (game may be globally visible, not delisted)
                            console.warn(`[M-CORE] App ${appIdStr} unavailable in RU/KZ for ${user.name}, trying global...`);
                            const globalDetails = await getAppDetails(appIdStr, '');

                            if (globalDetails) {
                                // Game exists globally but not in RU — send full notification
                                console.log(`[M-CORE] App ${appIdStr} found globally (region-locked in RU)`);
                                const protonTier = await getCompatibilityText(appIdStr);
                                const html = formatGameMessage(user.name, globalDetails, null, protonTier, appIdStr, false);
                                await sendTelegramMessage(html, settings.telegramChatId, settings.telegramToken, globalDetails.header_image);

                                await prisma.messageHistory.create({
                                    data: {
                                        userName: user.name,
                                        gameName: globalDetails.name,
                                        isTest: false,
                                    }
                                });
                                continue;
                            }

                            // Game truly unavailable — use SteamSpy fallback for name
                            console.warn(`[M-CORE] App ${appIdStr} unavailable globally, using SteamSpy fallback`);
                            const fallbackName = await getAppNameFallback(appIdStr);
                            const gameName = fallbackName || `Unknown App ${appIdStr}`;
                            const delistedHtml = formatDelistedGameMessage(user.name, gameName, appIdStr);
                            await sendTelegramMessage(delistedHtml, settings.telegramChatId, settings.telegramToken);

                            await prisma.messageHistory.create({
                                data: {
                                    userName: user.name,
                                    gameName: `${gameName} (unavailable)`,
                                    isTest: false,
                                }
                            });
                            // END_BLOCK_REGION_FALLBACK
                            continue;
                        }

                        const detailsKz = await getAppDetails(appIdStr, 'kz');
                        const protonTier = await getCompatibilityText(appIdStr);

                        let kzPriceRub: number | undefined;
                        if (detailsKz?.price_overview) {
                            const rate = await getKztRate();
                            kzPriceRub = convertKztToRub(detailsKz.price_overview.final, rate);
                        }

                        const html = formatGameMessage(user.name, detailsRu, detailsKz, protonTier, appIdStr, false, kzPriceRub);
                        await sendTelegramMessage(html, settings.telegramChatId, settings.telegramToken, detailsRu.header_image);

                        await prisma.messageHistory.create({
                            data: {
                                userName: user.name,
                                gameName: detailsRu.name,
                                isTest: false,
                            }
                        });
                    } catch (detailErr) {
                        console.error(`[M-CORE] Failed to process app ${appIdStr} for user ${user.name}:`, detailErr);
                    }
                }
            }

            if (isFirstSync && newGames.length > 0) {
                console.log(`[M-CORE] Bulk/First sync for ${user.name}: silently added ${newGames.length} games.`);
            }
        } catch (err) {
            console.error(`[M-CORE] Failed to poll user ${user.name}:`, err);
        }
    }
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
// END_CHANGE_SUMMARY
