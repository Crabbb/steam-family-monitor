// FILE: src/__tests__/worker.test.ts
// VERSION: 1.1.0

import { buildFreePromotionsCron, buildPerfectAchievementsCron, buildWatchlistCron } from "../lib/worker";

jest.mock("node-cron", () => ({
    schedule: jest.fn(),
}));

jest.mock("../lib/db", () => ({
    prisma: {
        settings: { findUnique: jest.fn() },
    },
}));

describe("M-CRON: configurable schedules", () => {
    it("builds the default free promotions hourly daytime schedule", () => {
        expect(buildFreePromotionsCron(9, 23, 1)).toBe("0 9-23/1 * * *");
    });

    it("builds the default perfect achievements daytime schedule", () => {
        expect(buildPerfectAchievementsCron(9, 23, 6)).toBe("0 9-23/6 * * *");
    });

    it("rejects invalid perfect achievements scan windows", () => {
        expect(() => buildPerfectAchievementsCron(24, 23, 6)).toThrow("hours must be between 0 and 23");
        expect(() => buildPerfectAchievementsCron(9, 23, 0)).toThrow("interval hours must be between 1 and 24");
    });

    it("rejects invalid free promotions hour windows", () => {
        expect(() => buildFreePromotionsCron(23, 9, 1)).toThrow("start hour must be less than or equal to end hour");
    });

    it("builds a watchlist interval schedule from settings", () => {
        expect(buildWatchlistCron(12)).toBe("0 */12 * * *");
    });
});

describe("M-CRON: cron callbacks route through runTracked", () => {
    it("wraps every registered cron callback with runTracked using the contract job names", async () => {
        jest.resetModules();

        const scheduleMock = jest.fn<{ stop: () => void }, [cronStr: string, callback: () => Promise<void>, options?: unknown]>(
            () => ({ stop: jest.fn() }),
        );
        const runTrackedMock = jest.fn((_job: string, fn: (report: { processed: number }) => Promise<unknown>) => fn({ processed: 0 }));
        const pollAllUsersMock = jest.fn();
        const checkWatchlistPricesMock = jest.fn();
        const checkFreePromotionsMock = jest.fn();
        const checkPerfectAchievementsMock = jest.fn();

        jest.doMock("node-cron", () => ({ schedule: scheduleMock }));
        jest.doMock("../lib/jobRun", () => ({ runTracked: runTrackedMock }));
        jest.doMock("../lib/db", () => ({
            prisma: {
                settings: {
                    findUnique: jest.fn().mockResolvedValue({
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
                    }),
                },
            },
        }));
        jest.doMock("../lib/core", () => ({ pollAllUsers: pollAllUsersMock }));
        jest.doMock("../lib/watchlist", () => ({ checkWatchlistPrices: checkWatchlistPricesMock }));
        jest.doMock("../lib/freePromotions", () => ({ checkFreePromotions: checkFreePromotionsMock }));
        jest.doMock("../lib/achievements", () => ({ checkPerfectAchievements: checkPerfectAchievementsMock }));
        jest.doMock("../lib/telegramBot", () => ({ startTelegramBot: jest.fn() }));

        const worker = await import("../lib/worker");
        await worker.startWorker();

        expect(scheduleMock).toHaveBeenCalledTimes(4);

        for (const call of scheduleMock.mock.calls) {
            await call[1]();
        }

        expect(runTrackedMock).toHaveBeenCalledWith("library", expect.any(Function));
        expect(runTrackedMock).toHaveBeenCalledWith("watchlist", expect.any(Function));
        expect(runTrackedMock).toHaveBeenCalledWith("free-promos", expect.any(Function));
        expect(runTrackedMock).toHaveBeenCalledWith("achievements", expect.any(Function));
        expect(pollAllUsersMock).toHaveBeenCalledTimes(1);
        expect(checkWatchlistPricesMock).toHaveBeenCalledTimes(1);
        expect(checkFreePromotionsMock).toHaveBeenCalledTimes(1);
        expect(checkPerfectAchievementsMock).toHaveBeenCalledTimes(1);
    });
});
