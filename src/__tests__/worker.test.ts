// FILE: src/__tests__/worker.test.ts
// VERSION: 1.0.0

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
