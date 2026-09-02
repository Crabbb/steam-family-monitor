// FILE: src/__tests__/worker.singleton.test.ts
// VERSION: 1.0.0

describe("M-CRON: worker singleton state", () => {
    beforeEach(() => {
        jest.resetModules();
        delete (globalThis as { steamMonitorWorkerState?: unknown }).steamMonitorWorkerState;
        delete (globalThis as { steamMonitorWorkerCrashGuardRegistered?: unknown }).steamMonitorWorkerCrashGuardRegistered;
    });

    it("does not duplicate cron registrations when worker module is loaded through two module graphs", async () => {
        const scheduleMock = jest.fn(() => ({ stop: jest.fn() }));
        const settingsFindUnique = jest.fn().mockResolvedValue({
            checkInterval: 15,
            libraryPollingEnabled: true,
            watchlistEnabled: true,
            watchlistIntervalHours: 12,
            freePromosEnabled: true,
            freePromosStartHour: 9,
            freePromosEndHour: 23,
            freePromosIntervalHours: 1,
            freePromosTimezone: "Europe/Samara",
            achievementMonitoringEnabled: true,
            achievementStartHour: 9,
            achievementEndHour: 23,
            achievementIntervalHours: 1,
            achievementTimezone: "Europe/Samara",
        });

        jest.doMock("node-cron", () => ({ schedule: scheduleMock }));
        jest.doMock("../lib/db", () => ({
            prisma: { settings: { findUnique: settingsFindUnique } },
        }));
        jest.doMock("../lib/core", () => ({ pollAllUsers: jest.fn() }));
        jest.doMock("../lib/watchlist", () => ({ checkWatchlistPrices: jest.fn() }));
        jest.doMock("../lib/freePromotions", () => ({ checkFreePromotions: jest.fn() }));
        jest.doMock("../lib/achievements", () => ({ checkPerfectAchievements: jest.fn() }));
        jest.doMock("../lib/telegramBot", () => ({ startTelegramBot: jest.fn() }));

        const firstWorker = await import("../lib/worker");
        await firstWorker.startWorker();
        jest.resetModules();

        const secondWorker = await import("../lib/worker");
        await secondWorker.startWorker();

        expect(scheduleMock).toHaveBeenCalledTimes(4);
        expect(settingsFindUnique).toHaveBeenCalledTimes(2);
    });
});
