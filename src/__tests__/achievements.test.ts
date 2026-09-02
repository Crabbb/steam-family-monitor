// FILE: src/__tests__/achievements.test.ts
// VERSION: 1.0.0

import { prisma } from "../lib/db";
import {
    getAchievementSchema,
    getAppDetails,
    getCompatibilityText,
    getGlobalAchievementPercentages,
    getOwnedGames,
    getPlayerAchievements,
    getRecentlyPlayedGames,
} from "../lib/steam";
import { sendTelegramMessage } from "../lib/telegram";
import {
    buildAchievementSnapshot,
    checkPerfectAchievements,
    findLatestPerfectAchievementForUser,
    formatPerfectAchievementMessage,
} from "../lib/achievements";

jest.mock("../lib/db", () => ({
    prisma: {
        settings: { findUnique: jest.fn() },
        user: { findMany: jest.fn(), findUnique: jest.fn() },
        game: { findMany: jest.fn(), updateMany: jest.fn() },
        achievementProgressState: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn() },
        perfectAchievementNotification: { findUnique: jest.fn(), create: jest.fn() },
        messageHistory: { create: jest.fn() },
    },
}));

jest.mock("../lib/steam", () => ({
    getAchievementSchema: jest.fn(),
    getAppDetails: jest.fn(),
    getCompatibilityText: jest.fn(),
    getGlobalAchievementPercentages: jest.fn(),
    getOwnedGames: jest.fn(),
    getPlayerAchievements: jest.fn(),
    getRecentlyPlayedGames: jest.fn(),
}));

jest.mock("../lib/telegram", () => ({
    sendTelegramMessage: jest.fn(),
}));

const prismaMock = prisma as unknown as {
    settings: { findUnique: jest.Mock };
    user: { findMany: jest.Mock; findUnique: jest.Mock };
    game: { findMany: jest.Mock; updateMany: jest.Mock };
    achievementProgressState: { findUnique: jest.Mock; findMany: jest.Mock; upsert: jest.Mock };
    perfectAchievementNotification: { findUnique: jest.Mock; create: jest.Mock };
    messageHistory: { create: jest.Mock };
};
const getAchievementSchemaMock = getAchievementSchema as jest.MockedFunction<typeof getAchievementSchema>;
const getAppDetailsMock = getAppDetails as jest.MockedFunction<typeof getAppDetails>;
const getCompatibilityTextMock = getCompatibilityText as jest.MockedFunction<typeof getCompatibilityText>;
const getGlobalAchievementPercentagesMock = getGlobalAchievementPercentages as jest.MockedFunction<typeof getGlobalAchievementPercentages>;
const getOwnedGamesMock = getOwnedGames as jest.MockedFunction<typeof getOwnedGames>;
const getPlayerAchievementsMock = getPlayerAchievements as jest.MockedFunction<typeof getPlayerAchievements>;
const getRecentlyPlayedGamesMock = getRecentlyPlayedGames as jest.MockedFunction<typeof getRecentlyPlayedGames>;
const sendTelegramMessageMock = sendTelegramMessage as jest.MockedFunction<typeof sendTelegramMessage>;

const playerAchievements = {
    gameName: "Nocturnal",
    achievements: [
        { apiname: "FIRST", achieved: 1, unlocktime: 1_714_000_000, name: "First Flame", description: "Start." },
        { apiname: "LAST", achieved: 1, unlocktime: 1_714_086_400, name: "Mist Piercer", description: "Finish." },
        { apiname: "HARD", achieved: 1, unlocktime: 1_714_050_000, name: "Hard Run", description: "Win hard." },
    ],
};

const schema = {
    gameName: "Nocturnal",
    achievements: [
        { name: "FIRST", displayName: "First Flame", description: "Start." },
        { name: "LAST", displayName: "Mist Piercer", description: "Finish." },
        { name: "HARD", displayName: "Hard Run", description: "Win hard." },
    ],
};

describe("M-ACHIEVEMENTS: perfect achievement detection", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        global.fetch = jest.fn().mockResolvedValue({ ok: false }) as jest.Mock;
        jest.spyOn(console, "log").mockImplementation(() => undefined);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
        prismaMock.game.findMany.mockResolvedValue([]);
        prismaMock.game.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.achievementProgressState.findMany.mockResolvedValue([]);
        getRecentlyPlayedGamesMock.mockResolvedValue([]);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("builds a perfect snapshot with last unlocked and rarest achievement details", () => {
        const snapshot = buildAchievementSnapshot({
            appId: "1634080",
            playtimeMinutes: 181,
            playerAchievements,
            schema,
            globalPercentages: [
                { name: "FIRST", percent: 86.1 },
                { name: "LAST", percent: 11.5 },
                { name: "HARD", percent: 5.2 },
            ],
            steamHunters: {
                playersStartedCount: 365,
                playersPerfectedCount: 175,
                fastestCompletionTime: 114,
                medianCompletionTime: 181,
                hasPaidDlc: false,
            },
            compatibilityText: "Verified / ProtonDB Platinum",
        });

        expect(snapshot).toMatchObject({
            appId: "1634080",
            gameName: "Nocturnal",
            achievedCount: 3,
            totalCount: 3,
            isPerfect: true,
            playtimeMinutes: 181,
            compatibilityText: "Verified / ProtonDB Platinum",
            lastUnlocked: { apiName: "LAST", displayName: "Mist Piercer" },
            rarestUnlocked: { apiName: "HARD", displayName: "Hard Run", globalPercent: 5.2 },
            steamHunters: {
                playersStartedCount: 365,
                playersPerfectedCount: 175,
                medianCompletionTime: 181,
            },
        });
        expect(snapshot.completionKey).toBe("3:1714086400");
        expect(snapshot.completedAt?.toISOString()).toBe("2024-04-25T23:06:40.000Z");
    });

    it("formats a sunflower message with source-aware rarity and required links", () => {
        const snapshot = buildAchievementSnapshot({
            appId: "1634080",
            playtimeMinutes: 181,
            playerAchievements,
            schema,
            globalPercentages: [
                { name: "FIRST", percent: 86.1 },
                { name: "LAST", percent: 11.5 },
                { name: "HARD", percent: 5.2 },
            ],
            steamHunters: {
                playersStartedCount: 365,
                playersPerfectedCount: 175,
                fastestCompletionTime: 114,
                medianCompletionTime: 181,
                hasPaidDlc: false,
            },
            compatibilityText: "Verified / ProtonDB Platinum",
        });

        const html = formatPerfectAchievementMessage("Дима", snapshot, true);

        expect(html).toContain("[ТЕСТ]");
        expect(html).toContain("Подсолнух у Дима");
        expect(html).toContain("100% достижений: 3/3");
        expect(html).toContain("Hard Run");
        expect(html).toContain("5.2%");
        expect(html).toContain("SteamHunters");
        expect(html).toContain("47.9%");
        expect(html).toContain("у Дима в игре");
        expect(html).toContain("медиана 100% SteamHunters");
        expect(html).toContain("https://store.steampowered.com/app/1634080");
        expect(html).toContain("https://steamcommunity.com/profiles/");
        expect(html).toContain("https://steamdb.info/app/1634080/");
        expect(html).toContain("https://steamhunters.com/apps/1634080");
    });

    it("sends a scheduled notification only when an existing incomplete state becomes perfect", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            achievementMonitoringEnabled: true,
            achievementScanLimit: 10,
            achievementFullScanIntervalHours: 24,
            achievementSteamHuntersEnabled: true,
        });
        prismaMock.user.findMany.mockResolvedValueOnce([{ id: 2, name: "Дима", steamId: "7656" }]);
        getOwnedGamesMock.mockResolvedValueOnce([{ appid: 1634080, playtime_forever: 181 }]);
        prismaMock.game.findMany.mockResolvedValueOnce([{ appId: "1634080", playtimeForever: 120 }]);
        prismaMock.achievementProgressState.findMany.mockResolvedValueOnce([{
            appId: "1634080",
            achievedCount: 2,
            totalCount: 3,
            completionKey: null,
            completedAt: null,
            lastCheckedAt: new Date("2026-04-28T00:00:00.000Z"),
        }]);
        getPlayerAchievementsMock.mockResolvedValueOnce(playerAchievements);
        getAchievementSchemaMock.mockResolvedValueOnce(schema);
        getGlobalAchievementPercentagesMock.mockResolvedValueOnce([
            { name: "FIRST", percent: 86.1 },
            { name: "LAST", percent: 11.5 },
            { name: "HARD", percent: 5.2 },
        ]);
        getCompatibilityTextMock.mockResolvedValueOnce("Verified / ProtonDB Platinum");
        getAppDetailsMock.mockResolvedValueOnce({ name: "Nocturnal", header_image: "https://cdn/header.jpg" });
        prismaMock.achievementProgressState.findUnique.mockResolvedValueOnce({
            userId: 2,
            appId: "1634080",
            achievedCount: 2,
            totalCount: 3,
            completedAt: null,
        });
        prismaMock.perfectAchievementNotification.findUnique.mockResolvedValueOnce(null);
        sendTelegramMessageMock.mockResolvedValueOnce(true);
        prismaMock.perfectAchievementNotification.create.mockResolvedValueOnce({});
        prismaMock.achievementProgressState.upsert.mockResolvedValueOnce({});

        await checkPerfectAchievements();

        expect(sendTelegramMessageMock).toHaveBeenCalledWith(
            expect.stringContaining("Подсолнух"),
            "chat",
            "token",
            "https://cdn/header.jpg",
        );
        expect(prismaMock.perfectAchievementNotification.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: 2,
                appId: "1634080",
                completionKey: "3:1714086400",
                gameName: "Nocturnal",
            }),
        });
        expect(prismaMock.achievementProgressState.upsert).toHaveBeenCalled();
    });

    it("does not send historical perfect games during the first baseline scan", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            achievementMonitoringEnabled: true,
            achievementScanLimit: 10,
            achievementFullScanIntervalHours: 24,
            achievementSteamHuntersEnabled: false,
        });
        prismaMock.user.findMany.mockResolvedValueOnce([{ id: 2, name: "Дима", steamId: "7656" }]);
        getOwnedGamesMock.mockResolvedValueOnce([{ appid: 1634080, playtime_forever: 181 }]);
        prismaMock.game.findMany.mockResolvedValueOnce([{ appId: "1634080", playtimeForever: 0 }]);
        prismaMock.achievementProgressState.findMany.mockResolvedValueOnce([]);
        getPlayerAchievementsMock.mockResolvedValueOnce(playerAchievements);
        getAchievementSchemaMock.mockResolvedValueOnce(schema);
        getGlobalAchievementPercentagesMock.mockResolvedValueOnce([]);
        getCompatibilityTextMock.mockResolvedValueOnce(null);
        prismaMock.achievementProgressState.findUnique.mockResolvedValueOnce(null);
        prismaMock.achievementProgressState.upsert.mockResolvedValueOnce({});

        await checkPerfectAchievements();

        expect(sendTelegramMessageMock).not.toHaveBeenCalled();
        expect(prismaMock.perfectAchievementNotification.create).not.toHaveBeenCalled();
        expect(prismaMock.achievementProgressState.upsert).toHaveBeenCalled();
    });

    it("checks only tracked games whose playtime changed during scheduled scans", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            achievementMonitoringEnabled: true,
            achievementScanLimit: 10,
            achievementFullScanIntervalHours: 24,
            achievementSteamHuntersEnabled: false,
        });
        prismaMock.user.findMany.mockResolvedValueOnce([{ id: 4, name: "Вова", steamId: "7656" }]);
        getOwnedGamesMock.mockResolvedValueOnce([
            { appid: 1245620, playtime_forever: 9000 },
            { appid: 111, playtime_forever: 50 },
        ]);
        prismaMock.game.findMany.mockResolvedValueOnce([
            { appId: "1245620", playtimeForever: 8700 },
            { appId: "111", playtimeForever: 50 },
        ]);
        prismaMock.achievementProgressState.findMany.mockResolvedValueOnce([
            {
                appId: "1245620",
                achievedCount: 2,
                totalCount: 3,
                completionKey: null,
                completedAt: null,
                lastCheckedAt: new Date("2026-04-28T00:00:00.000Z"),
            },
            {
                appId: "111",
                achievedCount: 1,
                totalCount: 1,
                completionKey: "1:100",
                completedAt: new Date("2024-01-01T00:00:00.000Z"),
                lastCheckedAt: new Date(),
            },
        ]);
        getPlayerAchievementsMock.mockResolvedValueOnce({
            gameName: "ELDEN RING",
            achievements: [
                { apiname: "FIRST", achieved: 1, unlocktime: 100, name: "First" },
                { apiname: "LAST", achieved: 1, unlocktime: 200, name: "Elden Ring" },
                { apiname: "HARD", achieved: 1, unlocktime: 300, name: "Hard" },
            ],
        });
        getAchievementSchemaMock.mockResolvedValueOnce({
            gameName: "ELDEN RING",
            achievements: [
                { name: "FIRST", displayName: "First" },
                { name: "LAST", displayName: "Elden Ring" },
                { name: "HARD", displayName: "Hard" },
            ],
        });
        getGlobalAchievementPercentagesMock.mockResolvedValueOnce([]);
        getCompatibilityTextMock.mockResolvedValueOnce("Verified / ProtonDB Platinum");
        getAppDetailsMock.mockResolvedValueOnce({ name: "ELDEN RING", header_image: "https://cdn/elden.jpg" });
        prismaMock.perfectAchievementNotification.findUnique.mockResolvedValueOnce(null);
        sendTelegramMessageMock.mockResolvedValueOnce(true);
        prismaMock.perfectAchievementNotification.create.mockResolvedValueOnce({});
        prismaMock.achievementProgressState.upsert.mockResolvedValue({});

        await checkPerfectAchievements();

        expect(getPlayerAchievementsMock).toHaveBeenCalledTimes(1);
        expect(getPlayerAchievementsMock).toHaveBeenCalledWith("1245620", "7656", "steam");
        expect(sendTelegramMessageMock).toHaveBeenCalledWith(
            expect.stringContaining("ELDEN RING"),
            "chat",
            "token",
            "https://cdn/elden.jpg",
        );
        expect(prismaMock.game.updateMany).toHaveBeenCalledWith({
            where: { userId: 4, appId: "1245620" },
            data: { playtimeForever: 9000 },
        });
    });

    it("uses recently played games as achievement candidates when they are absent from owned games", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            achievementMonitoringEnabled: true,
            achievementScanLimit: 10,
            achievementFullScanIntervalHours: 24,
            achievementSteamHuntersEnabled: false,
        });
        prismaMock.user.findMany.mockResolvedValueOnce([{ id: 4, name: "Вова", steamId: "7656" }]);
        getOwnedGamesMock.mockResolvedValueOnce([{ appid: 111, playtime_forever: 50 }]);
        getRecentlyPlayedGamesMock.mockResolvedValueOnce([{ appid: 1245620, playtime_forever: 2835, playtime_2weeks: 2372 }]);
        prismaMock.game.findMany.mockResolvedValueOnce([{ appId: "111", playtimeForever: 50 }]);
        prismaMock.achievementProgressState.findMany.mockResolvedValueOnce([{
            appId: "1245620",
            achievedCount: 41,
            totalCount: 42,
            playtimeForever: 2500,
            completionKey: null,
            completedAt: null,
            lastCheckedAt: new Date("2026-04-28T00:00:00.000Z"),
        }, {
            appId: "111",
            achievedCount: 1,
            totalCount: 1,
            playtimeForever: 50,
            completionKey: "1:100",
            completedAt: new Date("2024-01-01T00:00:00.000Z"),
            lastCheckedAt: new Date(),
        }]);
        getPlayerAchievementsMock.mockResolvedValueOnce({
            gameName: "ELDEN RING",
            achievements: [
                { apiname: "FIRST", achieved: 1, unlocktime: 100, name: "First" },
                { apiname: "LAST", achieved: 1, unlocktime: 1_777_324_400, name: "Elden Ring" },
            ],
        });
        getAchievementSchemaMock.mockResolvedValueOnce({
            gameName: "ELDEN RING",
            achievements: [
                { name: "FIRST", displayName: "First" },
                { name: "LAST", displayName: "Elden Ring" },
            ],
        });
        getGlobalAchievementPercentagesMock.mockResolvedValueOnce([]);
        getCompatibilityTextMock.mockResolvedValueOnce("Verified / ProtonDB Platinum");
        getAppDetailsMock.mockResolvedValueOnce({ name: "ELDEN RING", header_image: "https://cdn/elden.jpg" });
        prismaMock.perfectAchievementNotification.findUnique.mockResolvedValueOnce(null);
        sendTelegramMessageMock.mockResolvedValueOnce(true);
        prismaMock.perfectAchievementNotification.create.mockResolvedValueOnce({});
        prismaMock.achievementProgressState.upsert.mockResolvedValue({});

        await checkPerfectAchievements();

        expect(getPlayerAchievementsMock).toHaveBeenCalledTimes(1);
        expect(getPlayerAchievementsMock).toHaveBeenCalledWith("1245620", "7656", "steam");
        expect(sendTelegramMessageMock).toHaveBeenCalledWith(
            expect.stringContaining("ELDEN RING"),
            "chat",
            "token",
            "https://cdn/elden.jpg",
        );
        expect(prismaMock.achievementProgressState.upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({ playtimeForever: 2835 }),
        }));
        expect(prismaMock.game.updateMany).toHaveBeenCalledWith({
            where: { userId: 4, appId: "1245620" },
            data: { playtimeForever: 2835 },
        });
    });

    it("does not call player-achievement API for unchanged games before the full-scan window", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            achievementMonitoringEnabled: true,
            achievementScanLimit: 10,
            achievementFullScanIntervalHours: 24,
            achievementSteamHuntersEnabled: false,
        });
        prismaMock.user.findMany.mockResolvedValueOnce([{ id: 4, name: "Вова", steamId: "7656" }]);
        getOwnedGamesMock.mockResolvedValueOnce([
            { appid: 1245620, playtime_forever: 9000 },
            { appid: 111, playtime_forever: 50 },
        ]);
        prismaMock.game.findMany.mockResolvedValueOnce([
            { appId: "1245620", playtimeForever: 9000 },
            { appId: "111", playtimeForever: 50 },
        ]);
        prismaMock.achievementProgressState.findMany.mockResolvedValueOnce([
            { appId: "1245620", achievedCount: 3, totalCount: 3, completionKey: "3:300", lastCheckedAt: new Date() },
            { appId: "111", achievedCount: 1, totalCount: 1, completionKey: "1:100", lastCheckedAt: new Date() },
        ]);

        await checkPerfectAchievements();

        expect(getPlayerAchievementsMock).not.toHaveBeenCalled();
        expect(sendTelegramMessageMock).not.toHaveBeenCalled();
        expect(prismaMock.achievementProgressState.upsert).not.toHaveBeenCalled();
    });

    it("rechecks unchanged games when their achievement state is older than the full-scan window", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            achievementMonitoringEnabled: true,
            achievementScanLimit: 10,
            achievementFullScanIntervalHours: 24,
            achievementSteamHuntersEnabled: false,
        });
        prismaMock.user.findMany.mockResolvedValueOnce([{ id: 4, name: "Вова", steamId: "7656" }]);
        getOwnedGamesMock.mockResolvedValueOnce([{ appid: 1245620, playtime_forever: 9000 }]);
        prismaMock.game.findMany.mockResolvedValueOnce([{ appId: "1245620", playtimeForever: 9000 }]);
        prismaMock.achievementProgressState.findMany.mockResolvedValueOnce([{
            appId: "1245620",
            achievedCount: 2,
            totalCount: 3,
            completionKey: null,
            completedAt: null,
            lastCheckedAt: new Date("2026-04-20T00:00:00.000Z"),
        }]);
        getPlayerAchievementsMock.mockResolvedValueOnce({
            gameName: "ELDEN RING",
            achievements: [
                { apiname: "FIRST", achieved: 1, unlocktime: 100, name: "First" },
                { apiname: "LAST", achieved: 0, unlocktime: 0, name: "Elden Ring" },
                { apiname: "HARD", achieved: 1, unlocktime: 300, name: "Hard" },
            ],
        });
        prismaMock.achievementProgressState.upsert.mockResolvedValueOnce({});

        await checkPerfectAchievements();

        expect(getPlayerAchievementsMock).toHaveBeenCalledTimes(1);
        expect(getPlayerAchievementsMock).toHaveBeenCalledWith("1245620", "7656", "steam");
        expect(sendTelegramMessageMock).not.toHaveBeenCalled();
        expect(prismaMock.achievementProgressState.upsert).toHaveBeenCalled();
    });

    it("finds and sends the latest historical perfect game for a single user test", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            achievementSteamHuntersEnabled: false,
        });
        prismaMock.user.findUnique.mockResolvedValueOnce({ id: 2, name: "Дима", steamId: "7656" });
        getOwnedGamesMock.mockResolvedValueOnce([
            { appid: 10, playtime_forever: 40 },
            { appid: 20, playtime_forever: 30 },
        ]);
        getPlayerAchievementsMock
            .mockResolvedValueOnce({
                gameName: "Older Perfect",
                achievements: [{ apiname: "DONE", achieved: 1, unlocktime: 100, name: "Done" }],
            })
            .mockResolvedValueOnce({
                gameName: "Latest Perfect",
                achievements: [{ apiname: "DONE", achieved: 1, unlocktime: 200, name: "Done" }],
            });
        getAchievementSchemaMock
            .mockResolvedValueOnce({ gameName: "Older Perfect", achievements: [{ name: "DONE", displayName: "Done" }] })
            .mockResolvedValueOnce({ gameName: "Latest Perfect", achievements: [{ name: "DONE", displayName: "Done" }] });
        getGlobalAchievementPercentagesMock.mockResolvedValue([]);
        getCompatibilityTextMock.mockResolvedValue(null);
        getAppDetailsMock.mockResolvedValueOnce({ name: "Latest Perfect", header_image: "https://cdn/latest.jpg" });
        sendTelegramMessageMock.mockResolvedValueOnce(true);
        prismaMock.messageHistory.create.mockResolvedValueOnce({});

        const result = await findLatestPerfectAchievementForUser(2, { sendMessage: true });

        expect(result?.appId).toBe("20");
        expect(sendTelegramMessageMock).toHaveBeenCalledWith(
            expect.stringContaining("[ТЕСТ]"),
            "chat",
            "token",
            "https://cdn/latest.jpg",
        );
        expect(prismaMock.messageHistory.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userName: "Дима",
                gameName: "Latest Perfect",
                isTest: true,
            }),
        });
    });

    it("uses player achievement progress first and enriches only the latest perfect game during manual tests", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            achievementSteamHuntersEnabled: false,
        });
        prismaMock.user.findUnique.mockResolvedValueOnce({ id: 2, name: "Дима", steamId: "7656" });
        getOwnedGamesMock.mockResolvedValueOnce([
            { appid: 10, playtime_forever: 40 },
            { appid: 20, playtime_forever: 30 },
            { appid: 30, playtime_forever: 20 },
        ]);
        getPlayerAchievementsMock
            .mockResolvedValueOnce({
                gameName: "Incomplete",
                achievements: [
                    { apiname: "A", achieved: 1, unlocktime: 100, name: "A" },
                    { apiname: "B", achieved: 0, unlocktime: 0, name: "B" },
                ],
            })
            .mockResolvedValueOnce({
                gameName: "Latest Perfect",
                achievements: [{ apiname: "DONE", achieved: 1, unlocktime: 300, name: "Done" }],
            })
            .mockResolvedValueOnce({
                gameName: "Older Perfect",
                achievements: [{ apiname: "DONE", achieved: 1, unlocktime: 200, name: "Done" }],
            });
        getAchievementSchemaMock.mockResolvedValueOnce({
            gameName: "Latest Perfect",
            achievements: [{ name: "DONE", displayName: "Done" }],
        });
        getGlobalAchievementPercentagesMock.mockResolvedValueOnce([{ name: "DONE", percent: 9.9 }]);
        getCompatibilityTextMock.mockResolvedValueOnce("Playable / ProtonDB Gold");
        getAppDetailsMock.mockResolvedValueOnce({ name: "Latest Perfect", header_image: "https://cdn/latest.jpg" });
        sendTelegramMessageMock.mockResolvedValueOnce(true);
        prismaMock.messageHistory.create.mockResolvedValueOnce({});

        const result = await findLatestPerfectAchievementForUser(2, { sendMessage: true });

        expect(result?.appId).toBe("20");
        expect(getPlayerAchievementsMock).toHaveBeenCalledTimes(3);
        expect(getAchievementSchemaMock).toHaveBeenCalledTimes(1);
        expect(getAchievementSchemaMock).toHaveBeenCalledWith("20", "steam");
        expect(getGlobalAchievementPercentagesMock).toHaveBeenCalledTimes(1);
        expect(getCompatibilityTextMock).toHaveBeenCalledTimes(1);
        expect(sendTelegramMessageMock).toHaveBeenCalledWith(
            expect.stringContaining("Playable / ProtonDB Gold"),
            "chat",
            "token",
            "https://cdn/latest.jpg",
        );
    });

    it("formats numeric percentages when external APIs return them as strings", () => {
        const snapshot = buildAchievementSnapshot({
            appId: "20",
            steamId: "7656",
            playtimeMinutes: 120,
            playerAchievements: {
                gameName: "String Percent Game",
                achievements: [{ apiname: "DONE", achieved: 1, unlocktime: 300, name: "Done" }],
            },
            schema: { gameName: "String Percent Game", achievements: [{ name: "DONE", displayName: "Done" }] },
            globalPercentages: [{ name: "DONE", percent: "9.9" as unknown as number }],
            steamHunters: {
                playersStartedCount: "100" as unknown as number,
                playersPerfectedCount: "25" as unknown as number,
                medianCompletionTime: "90" as unknown as number,
            },
            compatibilityText: null,
        });

        const html = formatPerfectAchievementMessage("Дима", snapshot, true);

        expect(html).toContain("9.9%");
        expect(html).toContain("25.0%");
        expect(html).toContain("1ч 30м");
    });
});
