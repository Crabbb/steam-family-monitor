// FILE: src/__tests__/core.userFailures.test.ts
// VERSION: 1.0.0

import { prisma } from "../lib/db";
import { getOwnedGames, getAppDetails, getCompatibilityText } from "../lib/steam";
import { sendTelegramMessage } from "../lib/telegram";
import { pollAllUsers } from "../lib/core";

jest.mock("../lib/db", () => ({
    prisma: {
        settings: { findUnique: jest.fn() },
        user: { findMany: jest.fn(), update: jest.fn() },
        game: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
        messageHistory: { create: jest.fn() },
    },
}));

jest.mock("../lib/steam", () => ({
    ...jest.requireActual("../lib/steam"),
    getOwnedGames: jest.fn(),
    getAppDetails: jest.fn(),
    getAppNameFallback: jest.fn(),
    getCompatibilityText: jest.fn(),
}));

jest.mock("../lib/telegram", () => ({ sendTelegramMessage: jest.fn() }));
jest.mock("../lib/cbr", () => ({ getKztRate: jest.fn(), convertKztToRub: jest.fn(() => 100) }));

const prismaMock = prisma as unknown as {
    settings: { findUnique: jest.Mock };
    user: { findMany: jest.Mock; update: jest.Mock };
    game: { create: jest.Mock; update: jest.Mock; findMany: jest.Mock };
    messageHistory: { create: jest.Mock };
};

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    prismaMock.settings.findUnique.mockResolvedValue({
        steamApiKey: "key", telegramToken: "token", telegramChatId: "chat",
    });
    prismaMock.game.findMany.mockResolvedValue([]);
    prismaMock.game.create.mockResolvedValue({ id: 1 });
    (getAppDetails as jest.Mock).mockResolvedValue({ name: "Game", categories: [] });
    (getCompatibilityText as jest.Mock).mockResolvedValue("platinum");
});

afterEach(() => jest.restoreAllMocks());

describe("M-CORE: a broken profile is reported once", () => {
    it("counts a failure without alerting on the first two", async () => {
        prismaMock.user.findMany.mockResolvedValue([
            { id: 1, name: "Дима", steamId: "76561", games: [], consecutiveFailures: 0 },
        ]);
        (getOwnedGames as jest.Mock).mockRejectedValue(new Error("Steam API error: Unauthorized"));

        await pollAllUsers();

        expect(prismaMock.user.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 1 },
            data: expect.objectContaining({ consecutiveFailures: 1 }),
        }));
        expect(sendTelegramMessage).not.toHaveBeenCalled();
    });

    it("sends exactly one alert when the third failure in a row happens", async () => {
        prismaMock.user.findMany.mockResolvedValue([
            { id: 1, name: "Дима", steamId: "76561", games: [], consecutiveFailures: 2 },
        ]);
        (getOwnedGames as jest.Mock).mockRejectedValue(new Error("Steam API error: Unauthorized"));
        (sendTelegramMessage as jest.Mock).mockResolvedValue(true);

        await pollAllUsers();

        expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
        expect((sendTelegramMessage as jest.Mock).mock.calls[0][0]).toContain("Дима");
        expect((sendTelegramMessage as jest.Mock).mock.calls[0][0]).toContain("Unauthorized");
    });

    it("stays silent on the fourth failure", async () => {
        prismaMock.user.findMany.mockResolvedValue([
            { id: 1, name: "Дима", steamId: "76561", games: [], consecutiveFailures: 3 },
        ]);
        (getOwnedGames as jest.Mock).mockRejectedValue(new Error("Steam API error: Unauthorized"));

        await pollAllUsers();

        expect(sendTelegramMessage).not.toHaveBeenCalled();
    });

    it("resets the counter after a successful poll", async () => {
        prismaMock.user.findMany.mockResolvedValue([
            { id: 1, name: "Дима", steamId: "76561", games: [{ appId: "220", notifiedAt: new Date() }], consecutiveFailures: 3 },
        ]);
        (getOwnedGames as jest.Mock).mockResolvedValue([{ appid: 220 }]);

        await pollAllUsers();

        expect(prismaMock.user.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ consecutiveFailures: 0, lastError: null }),
        }));
    });

    it("does not let a broken failure-tracking write stop the rest of the batch", async () => {
        // User 1 fails Steam AND the bookkeeping write itself throws (e.g. SQLite busy). User 2
        // must still be polled this cycle: recording one user's failure is not allowed to abort
        // the outer for-loop for every user after them — the same isolation the per-game retry
        // and new-games loops already give the happy path.
        prismaMock.user.findMany.mockResolvedValue([
            { id: 1, name: "Дима", steamId: "76561", games: [], consecutiveFailures: 0 },
            { id: 2, name: "Стас", steamId: "76562", games: [], consecutiveFailures: 0 },
        ]);
        prismaMock.user.update.mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"));
        (getOwnedGames as jest.Mock)
            .mockRejectedValueOnce(new Error("Steam API error: Unauthorized"))
            .mockResolvedValueOnce([{ appid: 220 }]);

        await expect(pollAllUsers()).resolves.toBeUndefined();

        expect(getOwnedGames).toHaveBeenCalledTimes(2);
        expect(getOwnedGames).toHaveBeenCalledWith("76562", "key");
    });
});
