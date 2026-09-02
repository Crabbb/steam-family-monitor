// FILE: src/lib/achievements.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Detects Steam perfect-achievement "sunflower" events and formats Telegram notifications
//   SCOPE: Achievement snapshot building, SteamHunters enrichment, scheduled checks, and manual latest-perfect tests
//   DEPENDS: M-DB, M-STEAM, M-TG
//   LINKS: M-ACHIEVEMENTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   buildAchievementSnapshot - Merge Steam player/schema/global stats into one completion snapshot
//   formatPerfectAchievementMessage - Format a Telegram HTML sunflower notification
//   checkPerfectAchievements - Run scheduled baseline/update detection for monitored users
//   findLatestPerfectAchievementForUser - Find and optionally send one user's latest historical perfect game
// END_MODULE_MAP

import { prisma } from "./db";
import {
    getAchievementSchema,
    getAppDetails,
    getCompatibilityText,
    getGlobalAchievementPercentages,
    getOwnedGames,
    getPlayerAchievements,
    getRecentlyPlayedGames,
    SteamAchievementSchema,
    SteamGlobalAchievementPercentage,
    SteamPlayerAchievements,
} from "./steam";
import { sendTelegramMessage } from "./telegram";

export interface SteamHuntersAppStats {
    playersStartedCount?: number;
    playersPerfectedCount?: number;
    fastestCompletionTime?: number;
    medianCompletionTime?: number;
    hasPaidDlc?: boolean;
}

export interface NormalizedAchievement {
    apiName: string;
    displayName: string;
    description?: string;
    achieved: boolean;
    unlockTime?: number;
    globalPercent?: number;
}

export interface AchievementSnapshot {
    appId: string;
    steamId?: string;
    gameName: string;
    achievedCount: number;
    totalCount: number;
    isPerfect: boolean;
    completionKey: string;
    completedAt?: Date;
    playtimeMinutes?: number;
    compatibilityText?: string | null;
    achievements: NormalizedAchievement[];
    lastUnlocked?: NormalizedAchievement;
    rarestUnlocked?: NormalizedAchievement;
    steamHunters?: SteamHuntersAppStats | null;
}

export interface BuildAchievementSnapshotInput {
    appId: string;
    steamId?: string;
    playtimeMinutes?: number;
    playerAchievements: SteamPlayerAchievements;
    schema?: SteamAchievementSchema | null;
    globalPercentages?: SteamGlobalAchievementPercentage[];
    steamHunters?: SteamHuntersAppStats | null;
    compatibilityText?: string | null;
}

interface UserLike {
    id: number;
    name: string;
    steamId: string;
}

interface OwnedGameLike {
    appid: number;
    playtime_forever?: number;
}

interface AchievementScanCandidate {
    game: OwnedGameLike;
    playerAchievements: SteamPlayerAchievements;
    snapshot: AchievementSnapshot;
}

interface AchievementProgressStateLike {
    appId: string;
    playtimeForever?: number;
    achievedCount: number;
    totalCount: number;
    completionKey: string | null;
    completedAt?: Date | null;
    lastCheckedAt: Date;
}

interface AchievementScanPlan {
    games: OwnedGameLike[];
    statesByAppId: Map<string, AchievementProgressStateLike>;
}

interface FindLatestOptions {
    sendMessage?: boolean;
    scanLimit?: number;
}

// START_CONTRACT: buildAchievementSnapshot
//   PURPOSE: Merge Steam achievement sources into a normalized completion snapshot
//   INPUTS: { input: BuildAchievementSnapshotInput }
//   OUTPUTS: { AchievementSnapshot }
//   SIDE_EFFECTS: none
//   LINKS: M-ACHIEVEMENTS, M-STEAM
// END_CONTRACT: buildAchievementSnapshot
export function buildAchievementSnapshot(input: BuildAchievementSnapshotInput): AchievementSnapshot {
    // START_BLOCK_NORMALIZE_ACHIEVEMENTS
    const playerByName = new Map(input.playerAchievements.achievements.map(item => [item.apiname, item]));
    const percentByName = new Map((input.globalPercentages || []).map(item => [item.name, item.percent]));
    const schemaItems = input.schema?.achievements && input.schema.achievements.length > 0
        ? input.schema.achievements
        : input.playerAchievements.achievements.map(item => ({
            name: item.apiname,
            displayName: item.name,
            description: item.description,
        }));

    const achievements: NormalizedAchievement[] = schemaItems.map(schemaItem => {
        const playerItem = playerByName.get(schemaItem.name);
        const displayName = playerItem?.name || schemaItem.displayName || schemaItem.name;
        return {
            apiName: schemaItem.name,
            displayName,
            description: playerItem?.description || schemaItem.description,
            achieved: playerItem?.achieved === true || Number(playerItem?.achieved || 0) === 1,
            unlockTime: playerItem?.unlocktime && playerItem.unlocktime > 0 ? playerItem.unlocktime : undefined,
            globalPercent: percentByName.get(schemaItem.name),
        };
    });
    // END_BLOCK_NORMALIZE_ACHIEVEMENTS

    // START_BLOCK_COMPUTE_COMPLETION
    const achieved = achievements.filter(item => item.achieved);
    const lastUnlocked = achieved
        .filter(item => item.unlockTime)
        .sort((a, b) => (b.unlockTime || 0) - (a.unlockTime || 0))[0];
    const rarestUnlocked = achieved
        .filter(item => item.globalPercent !== undefined)
        .sort((a, b) => (a.globalPercent || 0) - (b.globalPercent || 0))[0];
    const totalCount = achievements.length;
    const achievedCount = achieved.length;
    const isPerfect = totalCount > 0 && achievedCount === totalCount;
    const completionKey = isPerfect
        ? `${totalCount}:${lastUnlocked?.unlockTime || 0}`
        : `${achievedCount}:${totalCount}`;

    return {
        appId: input.appId,
        steamId: input.steamId,
        gameName: input.playerAchievements.gameName || input.schema?.gameName || `App ${input.appId}`,
        achievedCount,
        totalCount,
        isPerfect,
        completionKey,
        completedAt: isPerfect && lastUnlocked?.unlockTime ? new Date(lastUnlocked.unlockTime * 1000) : undefined,
        playtimeMinutes: input.playtimeMinutes,
        compatibilityText: input.compatibilityText,
        achievements,
        lastUnlocked,
        rarestUnlocked,
        steamHunters: input.steamHunters,
    };
    // END_BLOCK_COMPUTE_COMPLETION
}

// START_CONTRACT: formatPerfectAchievementMessage
//   PURPOSE: Format a Telegram HTML message for a perfect-achievement event
//   INPUTS: { userName: string, snapshot: AchievementSnapshot, isTest?: boolean }
//   OUTPUTS: { string - Telegram HTML payload }
//   SIDE_EFFECTS: none
//   LINKS: M-ACHIEVEMENTS, M-TG
// END_CONTRACT: formatPerfectAchievementMessage
export function formatPerfectAchievementMessage(userName: string, snapshot: AchievementSnapshot, isTest: boolean = false): string {
    // START_BLOCK_FORMAT_SUNFLOWER_MESSAGE
    const steamUrl = `https://store.steampowered.com/app/${snapshot.appId}`;
    const achievementsUrl = `https://steamcommunity.com/profiles/${snapshot.steamId || ""}/stats/${snapshot.appId}/achievements/`;
    const steamDbUrl = `https://steamdb.info/app/${snapshot.appId}/`;
    const protonUrl = `https://www.protondb.com/app/${snapshot.appId}`;
    const steamHuntersUrl = `https://steamhunters.com/apps/${snapshot.appId}`;

    let msg = "";
    if (isTest) {
        msg += `<b>[ТЕСТ]</b>\n\n`;
    }

    msg += `🌻 <b>Подсолнух у ${escapeHtml(userName)}!</b>\n\n`;
    msg += `🎮 <b><a href="${steamUrl}">${escapeHtml(snapshot.gameName)}</a></b>\n\n`;
    msg += `✅ <b>100% достижений: ${snapshot.achievedCount}/${snapshot.totalCount}</b>\n`;

    if (snapshot.completedAt) {
        msg += `🕒 <b>Завершено:</b> ${escapeHtml(formatDate(snapshot.completedAt))}\n`;
    }

    if (snapshot.lastUnlocked) {
        msg += `🏁 <b>Последнее достижение:</b> ${escapeHtml(snapshot.lastUnlocked.displayName)}\n`;
    }

    if (snapshot.rarestUnlocked?.globalPercent !== undefined) {
        msg += `📉 <b>Самое редкое достижение в Steam:</b> ${escapeHtml(snapshot.rarestUnlocked.displayName)} — ${formatPercent(snapshot.rarestUnlocked.globalPercent)} игроков\n`;
    }

    if (snapshot.compatibilityText) {
        msg += `🐧 <b>Steam Deck / Linux:</b> <a href="${protonUrl}">${escapeHtml(snapshot.compatibilityText)}</a>\n`;
    }

    if (snapshot.steamHunters?.playersPerfectedCount !== undefined && snapshot.steamHunters.playersStartedCount) {
        const shPercent = snapshot.steamHunters.playersPerfectedCount / snapshot.steamHunters.playersStartedCount * 100;
        msg += `\n🏹 <b>SteamHunters:</b> ${snapshot.steamHunters.playersPerfectedCount} из ${snapshot.steamHunters.playersStartedCount} отслеживаемых игроков сделали 100% (${formatPercent(shPercent)})\n`;

        if (snapshot.steamHunters.medianCompletionTime && snapshot.playtimeMinutes !== undefined) {
            msg += `⏱ <b>Время:</b> у ${escapeHtml(userName)} в игре — ${escapeHtml(formatMinutes(snapshot.playtimeMinutes))}; медиана 100% SteamHunters — ${escapeHtml(formatMinutes(snapshot.steamHunters.medianCompletionTime))}\n`;
        } else if (snapshot.steamHunters.medianCompletionTime) {
            msg += `⏱ <b>Медианное время 100% SteamHunters:</b> ${escapeHtml(formatMinutes(snapshot.steamHunters.medianCompletionTime))}\n`;
        } else if (snapshot.playtimeMinutes !== undefined) {
            msg += `⏱ <b>Время в игре у ${escapeHtml(userName)}:</b> ${escapeHtml(formatMinutes(snapshot.playtimeMinutes))}\n`;
        }
        if (snapshot.steamHunters.hasPaidDlc !== undefined) {
            msg += `🧩 <b>DLC для 100%:</b> ${snapshot.steamHunters.hasPaidDlc ? "может требоваться" : "не требуется"}\n`;
        }
    } else if (snapshot.playtimeMinutes !== undefined) {
        msg += `⏱ <b>Время в игре у ${escapeHtml(userName)}:</b> ${escapeHtml(formatMinutes(snapshot.playtimeMinutes))}\n`;
    }

    msg += `\n🔗 <a href="${steamUrl}">Steam</a> | <a href="${achievementsUrl}">Достижения</a> | <a href="${steamDbUrl}">SteamDB</a> | <a href="${steamHuntersUrl}">SteamHunters</a>`;
    return msg;
    // END_BLOCK_FORMAT_SUNFLOWER_MESSAGE
}

// START_CONTRACT: checkPerfectAchievements
//   PURPOSE: Scheduled job entry point for baseline/update achievement monitoring
//   INPUTS: {}
//   OUTPUTS: { Promise<void> }
//   SIDE_EFFECTS: Reads/writes SQLite via Prisma, sends Telegram messages
//   LINKS: M-ACHIEVEMENTS, M-DB, M-TG
// END_CONTRACT: checkPerfectAchievements
export async function checkPerfectAchievements(): Promise<void> {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings?.steamApiKey || !settings.telegramToken || !settings.telegramChatId || !settings.achievementMonitoringEnabled) {
        console.warn("[M-ACHIEVEMENTS] Achievement monitoring disabled or settings missing");
        return;
    }

    const users = await prisma.user.findMany();
    for (const user of users) {
        try {
            await checkUserPerfectAchievements(user, {
                apiKey: settings.steamApiKey,
                telegramToken: settings.telegramToken,
                telegramChatId: settings.telegramChatId,
                scanLimit: settings.achievementScanLimit || 1000,
                fullScanIntervalHours: settings.achievementFullScanIntervalHours || 24,
                steamHuntersEnabled: settings.achievementSteamHuntersEnabled,
                notifyTransitions: true,
            });
        } catch (err) {
            console.error(`[M-ACHIEVEMENTS] Failed to check user ${user.name}:`, err);
        }
    }
}

// START_CONTRACT: findLatestPerfectAchievementForUser
//   PURPOSE: Find one user's latest historical perfect game and optionally send it as a test message
//   INPUTS: { userId: number, options?: FindLatestOptions }
//   OUTPUTS: { Promise<AchievementSnapshot | null> }
//   SIDE_EFFECTS: Optional Telegram message and message history write
//   LINKS: M-ACHIEVEMENTS, M-API
// END_CONTRACT: findLatestPerfectAchievementForUser
export async function findLatestPerfectAchievementForUser(
    userId: number,
    options: FindLatestOptions = {},
): Promise<AchievementSnapshot | null> {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings?.steamApiKey) throw new Error("Steam API key is not configured");
    if (options.sendMessage && (!settings.telegramToken || !settings.telegramChatId)) {
        throw new Error("Telegram settings are not configured");
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error("User not found");

    const ownedGames = await getOwnedGames(user.steamId, settings.steamApiKey);
    const games = selectGamesForScan(ownedGames, options.scanLimit || ownedGames.length);
    const perfectCandidates = (await scanBasicAchievementCandidates(games, user.steamId, settings.steamApiKey))
        .filter(candidate => candidate.snapshot.isPerfect);
    const latestCandidate = perfectCandidates
        .sort((a, b) => (b.snapshot.completedAt?.getTime() || 0) - (a.snapshot.completedAt?.getTime() || 0))[0] || null;
    if (!latestCandidate) return null;

    const latest = await enrichAchievementSnapshot({
        appId: latestCandidate.snapshot.appId,
        steamId: user.steamId,
        apiKey: settings.steamApiKey,
        playtimeMinutes: latestCandidate.game.playtime_forever,
        playerAchievements: latestCandidate.playerAchievements,
        steamHuntersEnabled: settings.achievementSteamHuntersEnabled,
    });
    if (!latest) return null;

    if (options.sendMessage) {
        const details = await getPrimaryAppDetails(latest.appId);
        const messageSnapshot = {
            ...latest,
            gameName: details?.name || latest.gameName,
        };
        const html = formatPerfectAchievementMessage(user.name, messageSnapshot, true);
        const sent = await sendTelegramMessage(html, settings.telegramChatId, settings.telegramToken, details?.header_image);
        if (sent) {
            await prisma.messageHistory.create({
                data: {
                    userName: user.name,
                    gameName: messageSnapshot.gameName,
                    isTest: true,
                },
            });
        }
    }

    return latest;
}

async function checkUserPerfectAchievements(
    user: UserLike,
    options: {
        apiKey: string;
        telegramToken: string;
        telegramChatId: string;
        scanLimit: number;
        fullScanIntervalHours: number;
        steamHuntersEnabled: boolean;
        notifyTransitions: boolean;
    },
): Promise<void> {
    const [ownedGames, recentlyPlayedGames] = await Promise.all([
        getOwnedGames(user.steamId, options.apiKey),
        getRecentlyPlayedGames(user.steamId, options.apiKey, options.scanLimit),
    ]);
    const games = selectGamesForScan(mergeAchievementSourceGames(ownedGames, recentlyPlayedGames), options.scanLimit);
    const scanPlan = await selectAchievementScanPlan(user.id, games, options.fullScanIntervalHours);
    if (scanPlan.games.length === 0) {
        console.log(`[M-ACHIEVEMENTS] ${user.name}: no achievement candidates after playtime diff`);
        return;
    }

    console.log(`[M-ACHIEVEMENTS] ${user.name}: checking ${scanPlan.games.length}/${games.length} achievement candidates`);
    const candidates = await scanBasicAchievementCandidates(scanPlan.games, user.steamId, options.apiKey);
    const successfulAppIds = new Set(candidates.map(candidate => candidate.snapshot.appId));

    for (const game of scanPlan.games) {
        const appId = String(game.appid);
        if (successfulAppIds.has(appId)) continue;
        await upsertAchievementUnavailableState(user.id, appId, game.playtime_forever);
        await updateGamePlaytime(user.id, game);
    }

    for (const candidate of candidates) {
        const appId = candidate.snapshot.appId;
        const snapshot = candidate.snapshot;
        if (snapshot.totalCount === 0) continue;

        const previous = scanPlan.statesByAppId.get(appId) || null;
        const isBaseline = !previous;
        const alreadyRecorded = snapshot.isPerfect
            ? await prisma.perfectAchievementNotification.findUnique({
                where: {
                    userId_appId_completionKey: {
                        userId: user.id,
                        appId,
                        completionKey: snapshot.completionKey,
                    },
                },
            })
            : null;
        const samePerfectState = previous?.completionKey === snapshot.completionKey
            && previous.achievedCount === snapshot.achievedCount
            && previous.totalCount === snapshot.totalCount;
        const shouldNotify = options.notifyTransitions
            && !isBaseline
            && snapshot.isPerfect
            && !samePerfectState
            && !alreadyRecorded;

        if (shouldNotify) {
            const enrichedSnapshot = await enrichAchievementSnapshot({
                appId,
                steamId: user.steamId,
                apiKey: options.apiKey,
                playtimeMinutes: candidate.game.playtime_forever,
                playerAchievements: candidate.playerAchievements,
                steamHuntersEnabled: options.steamHuntersEnabled,
            }) || snapshot;
            const details = await getPrimaryAppDetails(appId);
            const messageSnapshot = {
                ...enrichedSnapshot,
                gameName: details?.name || enrichedSnapshot.gameName,
            };
            const html = formatPerfectAchievementMessage(user.name, messageSnapshot, false);
            const sent = await sendTelegramMessage(html, options.telegramChatId, options.telegramToken, details?.header_image);
            if (!sent) continue;

            await prisma.perfectAchievementNotification.create({
                data: {
                    userId: user.id,
                    appId,
                    completionKey: enrichedSnapshot.completionKey,
                    gameName: messageSnapshot.gameName,
                    achievedCount: enrichedSnapshot.achievedCount,
                    totalCount: enrichedSnapshot.totalCount,
                    completedAt: enrichedSnapshot.completedAt,
                },
            });

            await upsertAchievementState(user.id, enrichedSnapshot);
            await updateGamePlaytime(user.id, candidate.game);
            continue;
        }

        await upsertAchievementState(user.id, snapshot);
        await updateGamePlaytime(user.id, candidate.game);
    }
}

async function enrichAchievementSnapshot(options: {
    appId: string;
    steamId: string;
    apiKey: string;
    playtimeMinutes?: number;
    playerAchievements: SteamPlayerAchievements;
    steamHuntersEnabled: boolean;
}): Promise<AchievementSnapshot | null> {
    const schema = await getAchievementSchema(options.appId, options.apiKey);
    const globalPercentages = await getGlobalAchievementPercentages(options.appId);
    const compatibilityText = await getCompatibilityText(options.appId);
    const steamHunters = options.steamHuntersEnabled
        ? await getSteamHuntersAppStats(options.appId)
        : null;

    return buildAchievementSnapshot({
        appId: options.appId,
        steamId: options.steamId,
        playtimeMinutes: options.playtimeMinutes,
        playerAchievements: options.playerAchievements,
        schema,
        globalPercentages,
        steamHunters,
        compatibilityText,
    });
}

function mergeAchievementSourceGames(ownedGames: OwnedGameLike[], recentlyPlayedGames: OwnedGameLike[]): OwnedGameLike[] {
    const byAppId = new Map<number, OwnedGameLike>();
    for (const game of [...ownedGames, ...recentlyPlayedGames]) {
        const existing = byAppId.get(game.appid);
        byAppId.set(game.appid, {
            appid: game.appid,
            playtime_forever: Math.max(
                normalizePlaytime(existing?.playtime_forever),
                normalizePlaytime(game.playtime_forever),
            ),
        });
    }
    return Array.from(byAppId.values());
}

async function selectAchievementScanPlan(
    userId: number,
    games: OwnedGameLike[],
    fullScanIntervalHours: number,
): Promise<AchievementScanPlan> {
    const appIds = games.map(game => String(game.appid));
    if (appIds.length === 0) {
        return { games: [], statesByAppId: new Map() };
    }

    const [trackedGames, states] = await Promise.all([
        prisma.game.findMany({
            where: { userId, appId: { in: appIds } },
            select: { appId: true, playtimeForever: true },
        }),
        prisma.achievementProgressState.findMany({
            where: { userId, appId: { in: appIds } },
            select: {
                appId: true,
                playtimeForever: true,
                achievedCount: true,
                totalCount: true,
                completionKey: true,
                completedAt: true,
                lastCheckedAt: true,
            },
        }),
    ]);

    const trackedByAppId = new Map(trackedGames.map(game => [game.appId, game]));
    const statesByAppId = new Map<string, AchievementProgressStateLike>(
        states.map(state => [state.appId, state]),
    );
    const fullScanHours = Math.max(1, fullScanIntervalHours || 24);
    const staleBefore = new Date(Date.now() - fullScanHours * 60 * 60 * 1000);

    const candidates = games.filter(game => {
        const appId = String(game.appid);
        const tracked = trackedByAppId.get(appId);
        const state = statesByAppId.get(appId);

        const currentPlaytime = normalizePlaytime(game.playtime_forever);
        const previousPlaytime = normalizePlaytime(tracked?.playtimeForever ?? state?.playtimeForever);
        if (currentPlaytime !== previousPlaytime) return true;

        if (!state) return currentPlaytime > 0;
        return state.lastCheckedAt < staleBefore;
    });

    return { games: candidates, statesByAppId };
}

async function scanBasicAchievementCandidates(
    games: OwnedGameLike[],
    steamId: string,
    apiKey: string,
    batchSize: number = 8,
): Promise<AchievementScanCandidate[]> {
    const results: AchievementScanCandidate[] = [];

    for (let index = 0; index < games.length; index += batchSize) {
        const batch = games.slice(index, index + batchSize);
        const batchResults = await Promise.all(batch.map(async (game) => {
            const appId = String(game.appid);
            const playerAchievements = await getPlayerAchievements(appId, steamId, apiKey);
            if (!playerAchievements) return null;

            return {
                game,
                playerAchievements,
                snapshot: buildAchievementSnapshot({
                    appId,
                    steamId,
                    playtimeMinutes: game.playtime_forever,
                    playerAchievements,
                    schema: null,
                    globalPercentages: [],
                    steamHunters: null,
                    compatibilityText: null,
                }),
            };
        }));

        results.push(...batchResults.filter((item): item is AchievementScanCandidate => item !== null));
    }

    return results;
}

async function upsertAchievementState(userId: number, snapshot: AchievementSnapshot): Promise<void> {
    await prisma.achievementProgressState.upsert({
        where: { userId_appId: { userId, appId: snapshot.appId } },
        update: {
            playtimeForever: normalizePlaytime(snapshot.playtimeMinutes),
            achievedCount: snapshot.achievedCount,
            totalCount: snapshot.totalCount,
            completionKey: snapshot.isPerfect ? snapshot.completionKey : null,
            completedAt: snapshot.completedAt,
            lastCheckedAt: new Date(),
        },
        create: {
            userId,
            appId: snapshot.appId,
            playtimeForever: normalizePlaytime(snapshot.playtimeMinutes),
            achievedCount: snapshot.achievedCount,
            totalCount: snapshot.totalCount,
            completionKey: snapshot.isPerfect ? snapshot.completionKey : null,
            completedAt: snapshot.completedAt,
            lastCheckedAt: new Date(),
        },
    });
}

async function upsertAchievementUnavailableState(userId: number, appId: string, playtimeMinutes?: number): Promise<void> {
    await prisma.achievementProgressState.upsert({
        where: { userId_appId: { userId, appId } },
        update: {
            playtimeForever: normalizePlaytime(playtimeMinutes),
            achievedCount: 0,
            totalCount: 0,
            completionKey: null,
            completedAt: null,
            lastCheckedAt: new Date(),
        },
        create: {
            userId,
            appId,
            playtimeForever: normalizePlaytime(playtimeMinutes),
            achievedCount: 0,
            totalCount: 0,
            completionKey: null,
            completedAt: null,
            lastCheckedAt: new Date(),
        },
    });
}

async function updateGamePlaytime(userId: number, game: OwnedGameLike): Promise<void> {
    await prisma.game.updateMany({
        where: { userId, appId: String(game.appid) },
        data: { playtimeForever: normalizePlaytime(game.playtime_forever) },
    });
}

function normalizePlaytime(value: number | null | undefined): number {
    const numeric = Number(value || 0);
    return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

async function getSteamHuntersAppStats(appId: string): Promise<SteamHuntersAppStats | null> {
    try {
        const res = await fetch(`https://steamhunters.com/api/apps/${encodeURIComponent(appId)}`);
        if (!res.ok) return null;
        const data = await res.json() as SteamHuntersAppStats;
        return {
            playersStartedCount: data.playersStartedCount,
            playersPerfectedCount: data.playersPerfectedCount,
            fastestCompletionTime: data.fastestCompletionTime,
            medianCompletionTime: data.medianCompletionTime,
            hasPaidDlc: data.hasPaidDlc,
        };
    } catch {
        return null;
    }
}

async function getPrimaryAppDetails(appId: string) {
    const detailsRu = await getAppDetails(appId, "ru");
    if (detailsRu) return detailsRu;
    const detailsKz = await getAppDetails(appId, "kz");
    if (detailsKz) return detailsKz;
    return getAppDetails(appId, "");
}

function selectGamesForScan(games: OwnedGameLike[], limit: number) {
    const sorted = [...games].sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0));
    if (!Number.isFinite(limit) || limit <= 0 || limit >= sorted.length) return sorted;
    return sorted.slice(0, limit);
}

function formatDate(date: Date): string {
    return new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Samara",
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}

function formatMinutes(minutes: number): string {
    const total = Math.max(0, Math.round(minutes));
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    if (hours > 0 && mins > 0) return `${hours}ч ${mins}м`;
    if (hours > 0) return `${hours}ч`;
    return `${mins}м`;
}

function formatPercent(value: number | string): string {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return `${escapeHtml(String(value))}%`;
    return `${numeric.toFixed(1)}%`;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Added perfect-achievement monitoring, message formatting, and manual latest-perfect test flow]
//   LAST_CHANGE_2: [v1.1.0 - Use owned-game playtime diffs to scan only achievement candidates, with configurable full-scan fallback]
//   LAST_CHANGE_3: [v1.2.0 - Include recently played Steam apps as achievement candidates when owned library omits them]
// END_CHANGE_SUMMARY
