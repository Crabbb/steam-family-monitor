// FILE: src/__tests__/core.notifyRetry.test.ts
// VERSION: 1.0.0

import { prisma } from "../lib/db";
import { getOwnedGames, getAppDetails, getCompatibilityText } from "../lib/steam";
import { sendTelegramMessage } from "../lib/telegram";
import { pollAllUsers } from "../lib/core";

jest.mock("../lib/db", () => ({
    prisma: {
        settings: { findUnique: jest.fn() },
        user: { findMany: jest.fn() },
        game: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
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
    user: { findMany: jest.Mock };
    game: { create: jest.Mock; update: jest.Mock; updateMany: jest.Mock; findMany: jest.Mock };
    messageHistory: { create: jest.Mock };
};

describe("M-CORE: notification is confirmed, not assumed", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "log").mockImplementation(() => undefined);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
        jest.spyOn(console, "error").mockImplementation(() => undefined);

        prismaMock.settings.findUnique.mockResolvedValue({
            steamApiKey: "key", telegramToken: "token", telegramChatId: "chat",
        });
        (getAppDetails as jest.Mock).mockResolvedValue({
            name: "Half-Life 3", header_image: "https://cdn/h.jpg",
            categories: [{ id: 2, description: "Single-player" }],
        });
        (getCompatibilityText as jest.Mock).mockResolvedValue("platinum");
        prismaMock.game.findMany.mockResolvedValue([]);
        prismaMock.game.create.mockResolvedValue({ id: 10 });
    });

    afterEach(() => jest.restoreAllMocks());

    it("leaves notifiedAt empty and writes no history when Telegram refuses the message", async () => {
        prismaMock.user.findMany.mockResolvedValue([
            { id: 1, name: "Стас", steamId: "76561", games: [{ appId: "220", notifiedAt: new Date() }] },
        ]);
        (getOwnedGames as jest.Mock).mockResolvedValue([{ appid: 220 }, { appid: 300 }]);
        (sendTelegramMessage as jest.Mock).mockResolvedValue(false);

        await pollAllUsers();

        expect(prismaMock.game.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ appId: "300", notifiedAt: null }) }),
        );
        expect(prismaMock.messageHistory.create).not.toHaveBeenCalled();
        expect(prismaMock.game.update).not.toHaveBeenCalled();
    });

    it("marks the game notified and records history only after a successful send", async () => {
        prismaMock.user.findMany.mockResolvedValue([
            { id: 1, name: "Стас", steamId: "76561", games: [{ appId: "220", notifiedAt: new Date() }] },
        ]);
        (getOwnedGames as jest.Mock).mockResolvedValue([{ appid: 220 }, { appid: 300 }]);
        (sendTelegramMessage as jest.Mock).mockResolvedValue(true);

        await pollAllUsers();

        expect(prismaMock.game.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 10 },
            data: expect.objectContaining({ notifiedAt: expect.any(Date) }),
        }));
        expect(prismaMock.messageHistory.create).toHaveBeenCalledTimes(1);
    });

    it("retries a game left unnotified by the previous cycle", async () => {
        prismaMock.user.findMany.mockResolvedValue([
            { id: 1, name: "Стас", steamId: "76561", games: [{ appId: "220", notifiedAt: new Date() }] },
        ]);
        (getOwnedGames as jest.Mock).mockResolvedValue([{ appid: 220 }]);
        prismaMock.game.findMany.mockResolvedValue([
            { id: 42, appId: "300", userId: 1, discoveredAt: new Date(), notifiedAt: null },
        ]);
        (sendTelegramMessage as jest.Mock).mockResolvedValue(true);

        await pollAllUsers();

        expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
        expect(prismaMock.game.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 42 } }));
    });

    it("closes a game older than the retry window without sending", async () => {
        const old = new Date(Date.now() - 100 * 60 * 60 * 1000);
        prismaMock.user.findMany.mockResolvedValue([
            { id: 1, name: "Стас", steamId: "76561", games: [{ appId: "220", notifiedAt: new Date() }] },
        ]);
        (getOwnedGames as jest.Mock).mockResolvedValue([{ appid: 220 }]);
        prismaMock.game.findMany.mockResolvedValue([
            { id: 43, appId: "300", userId: 1, discoveredAt: old, notifiedAt: null },
        ]);

        await pollAllUsers();

        expect(sendTelegramMessage).not.toHaveBeenCalled();
        expect(prismaMock.game.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 43 } }));
    });

    it("does not let one poisoned pending game stop the rest of the retry batch", async () => {
        prismaMock.user.findMany.mockResolvedValue([
            { id: 1, name: "Стас", steamId: "76561", games: [{ appId: "220", notifiedAt: new Date() }] },
        ]);
        (getOwnedGames as jest.Mock).mockResolvedValue([{ appid: 220 }]);
        prismaMock.game.findMany.mockResolvedValue([
            { id: 42, appId: "300", userId: 1, discoveredAt: new Date(), notifiedAt: null },
            { id: 44, appId: "301", userId: 1, discoveredAt: new Date(), notifiedAt: null },
        ]);
        // App 300 is poisoned: every Steam lookup for it throws. 301 resolves normally.
        (getAppDetails as jest.Mock).mockImplementation(async (appId: string) => {
            if (appId === "300") throw new Error("Steam is down");
            return {
                name: "Half-Life 3", header_image: "https://cdn/h.jpg",
                categories: [{ id: 2, description: "Single-player" }],
            };
        });
        (sendTelegramMessage as jest.Mock).mockResolvedValue(true);

        await expect(pollAllUsers()).resolves.toBeUndefined();

        // The poisoned game is untouched: it stays notifiedAt: null so it is retried next cycle.
        expect(prismaMock.game.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 42 } }));
        // The second, healthy game in the same batch still gets notified and confirmed.
        expect(prismaMock.game.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 44 },
            data: expect.objectContaining({ notifiedAt: expect.any(Date) }),
        }));
        expect(prismaMock.messageHistory.create).toHaveBeenCalledTimes(1);
    });
});
