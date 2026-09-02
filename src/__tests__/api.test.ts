// FILE: src/__tests__/api.test.ts
// VERSION: 1.0.0

import { prisma } from "../lib/db";
import { findLatestPerfectAchievementForUser } from "../lib/achievements";
import { sendTestMessage } from "../lib/core";
import { POST as postAchievementTest } from "../app/api/achievements/test/route";
import { POST as postSettings } from "../app/api/settings/route";
import { POST as postUser } from "../app/api/users/route";
import { POST as postTestMessage } from "../app/api/test-message/route";

jest.mock("../lib/worker", () => ({
    startWorker: jest.fn(),
}));

jest.mock("../lib/db", () => ({
    prisma: {
        settings: {
            upsert: jest.fn(),
            findUnique: jest.fn(),
        },
        user: {
            create: jest.fn(),
        },
    },
}));

jest.mock("../lib/core", () => ({
    sendTestMessage: jest.fn(),
}));

jest.mock("../lib/achievements", () => ({
    findLatestPerfectAchievementForUser: jest.fn(),
}));

const prismaMock = prisma as unknown as {
    settings: {
        upsert: jest.Mock;
        findUnique: jest.Mock;
    };
    user: {
        create: jest.Mock;
    };
};
const sendTestMessageMock = sendTestMessage as jest.MockedFunction<typeof sendTestMessage>;
const findLatestPerfectAchievementForUserMock = findLatestPerfectAchievementForUser as jest.MockedFunction<typeof findLatestPerfectAchievementForUser>;

function jsonRequest(body: Record<string, unknown>): Request {
    return new Request("http://localhost/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

describe("M-API: route validation", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("rejects invalid settings intervals before writing to the database", async () => {
        const res = await postSettings(jsonRequest({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            checkInterval: "0",
        }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "checkInterval must be a positive integer" });
        expect(prismaMock.settings.upsert).not.toHaveBeenCalled();
    });

    it("saves valid settings with a parsed numeric interval", async () => {
        prismaMock.settings.upsert.mockResolvedValueOnce({
            id: 1,
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            checkInterval: 15,
            libraryPollingEnabled: true,
            watchlistEnabled: true,
            watchlistIntervalHours: 12,
            watchlistMinDiscountPct: 1,
            freePromosEnabled: true,
            freePromosIntervalHours: 1,
            freePromosStartHour: 9,
            freePromosEndHour: 23,
            freePromosTimezone: "Europe/Samara",
            freePromosRegionRu: true,
            freePromosRegionKz: true,
            freePromosSkipOwnedByAll: true,
            freePromosSearchCount: 100,
            achievementMonitoringEnabled: true,
            achievementIntervalHours: 6,
            achievementStartHour: 9,
            achievementEndHour: 23,
            achievementTimezone: "Europe/Samara",
            achievementScanLimit: 1000,
            achievementFullScanIntervalHours: 24,
            achievementSteamHuntersEnabled: true,
            achievementTestUserId: 2,
        });

        const res = await postSettings(jsonRequest({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            checkInterval: "15",
            libraryPollingEnabled: true,
            watchlistEnabled: true,
            watchlistIntervalHours: "12",
            watchlistMinDiscountPct: "1",
            freePromosEnabled: true,
            freePromosIntervalHours: "1",
            freePromosStartHour: "9",
            freePromosEndHour: "23",
            freePromosTimezone: "Europe/Samara",
            freePromosRegionRu: true,
            freePromosRegionKz: true,
            freePromosSkipOwnedByAll: true,
            freePromosSearchCount: "100",
            achievementMonitoringEnabled: true,
            achievementIntervalHours: "6",
            achievementStartHour: "9",
            achievementEndHour: "23",
            achievementTimezone: "Europe/Samara",
            achievementScanLimit: "1000",
            achievementFullScanIntervalHours: "24",
            achievementSteamHuntersEnabled: true,
            achievementTestUserId: "2",
        }));

        expect(res.status).toBe(200);
        expect(prismaMock.settings.upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({
                checkInterval: 15,
                libraryPollingEnabled: true,
                watchlistEnabled: true,
                watchlistIntervalHours: 12,
                watchlistMinDiscountPct: 1,
                freePromosEnabled: true,
                freePromosIntervalHours: 1,
                freePromosStartHour: 9,
                freePromosEndHour: 23,
                freePromosTimezone: "Europe/Samara",
                freePromosRegionRu: true,
                freePromosRegionKz: true,
                freePromosSkipOwnedByAll: true,
                freePromosSearchCount: 100,
                achievementMonitoringEnabled: true,
                achievementIntervalHours: 6,
                achievementStartHour: 9,
                achievementEndHour: 23,
                achievementTimezone: "Europe/Samara",
                achievementScanLimit: 1000,
                achievementFullScanIntervalHours: 24,
                achievementSteamHuntersEnabled: true,
                achievementTestUserId: 2,
            }),
            create: expect.objectContaining({ checkInterval: 15 }),
        }));
    });

    it("rejects invalid perfect achievement full-scan intervals before writing to the database", async () => {
        const res = await postSettings(jsonRequest({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            checkInterval: "15",
            achievementMonitoringEnabled: true,
            achievementFullScanIntervalHours: "0",
        }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "achievementFullScanIntervalHours must be between 1 and 168" });
        expect(prismaMock.settings.upsert).not.toHaveBeenCalled();
    });

    it("rejects invalid perfect achievement settings before writing to the database", async () => {
        const res = await postSettings(jsonRequest({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            checkInterval: "15",
            achievementMonitoringEnabled: true,
            achievementIntervalHours: "0",
        }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "achievementIntervalHours must be between 1 and 24" });
        expect(prismaMock.settings.upsert).not.toHaveBeenCalled();
    });

    it("rejects free promotion settings when both regions are disabled", async () => {
        const res = await postSettings(jsonRequest({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            checkInterval: "15",
            freePromosEnabled: true,
            freePromosRegionRu: false,
            freePromosRegionKz: false,
        }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "at least one free promotions region must be enabled" });
        expect(prismaMock.settings.upsert).not.toHaveBeenCalled();
    });

    it("rejects blank user fields before writing to the database", async () => {
        const res = await postUser(jsonRequest({ name: " ", steamId: "" }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "name and steamId are required" });
        expect(prismaMock.user.create).not.toHaveBeenCalled();
    });

    it("maps duplicate Steam IDs to a client error", async () => {
        prismaMock.user.create.mockRejectedValueOnce({ code: "P2002" });

        const res = await postUser(jsonRequest({ name: "Alice", steamId: "76561198000000000" }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "Steam ID already exists" });
    });

    it("rejects non-numeric test message user ids", async () => {
        const res = await postTestMessage(jsonRequest({ userId: "not-a-number" }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "userId must be a positive integer" });
        expect(sendTestMessageMock).not.toHaveBeenCalled();
    });

    it("sends test messages for valid numeric user ids", async () => {
        sendTestMessageMock.mockResolvedValueOnce(undefined);

        const res = await postTestMessage(jsonRequest({ userId: "42" }));

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ success: true });
        expect(sendTestMessageMock).toHaveBeenCalledWith(42);
    });

    it("rejects non-numeric perfect achievement test user ids", async () => {
        const res = await postAchievementTest(jsonRequest({ userId: "not-a-number" }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "userId must be a positive integer" });
        expect(findLatestPerfectAchievementForUserMock).not.toHaveBeenCalled();
    });

    it("sends the latest perfect achievement test for valid numeric user ids", async () => {
        findLatestPerfectAchievementForUserMock.mockResolvedValueOnce({ appId: "20" } as Awaited<ReturnType<typeof findLatestPerfectAchievementForUser>>);

        const res = await postAchievementTest(jsonRequest({ userId: "2" }));

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ success: true, appId: "20" });
        expect(findLatestPerfectAchievementForUserMock).toHaveBeenCalledWith(2, { sendMessage: true });
    });
});
