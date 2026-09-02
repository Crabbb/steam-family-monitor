// FILE: src/__tests__/core.digest.test.ts
// VERSION: 1.0.0

import { formatBundleDigestMessage } from "../lib/core";

describe("M-CORE: bundle digest", () => {
    it("lists every game with a store link and states the count", () => {
        const html = formatBundleDigestMessage("Стас", [
            { appId: "220", name: "Half-Life 2" },
            { appId: "440", name: "Team Fortress 2" },
            { appId: "570", name: "Dota 2" },
            { appId: "730", name: "Counter-Strike 2" },
            { appId: "620", name: "Portal 2" },
            { appId: "400", name: "Portal" },
        ]);

        expect(html).toContain("Стас: сразу 6 новых игр");
        expect(html).toContain('<a href="https://store.steampowered.com/app/220">Half-Life 2</a>');
        expect(html).toContain("Portal</a>");
        expect(html.length).toBeLessThanOrEqual(4096);
    });

    it("caps the list and says how many are hidden", () => {
        const many = Array.from({ length: 40 }, (_, i) => ({ appId: String(i), name: `Игра ${i}` }));

        const html = formatBundleDigestMessage("Дима", many);

        expect(html).toContain("и ещё 20");
        expect(html.length).toBeLessThanOrEqual(4096);
    });
});

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

describe("M-CORE: bundle digest in the polling cycle", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "log").mockImplementation(() => undefined);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
        jest.spyOn(console, "error").mockImplementation(() => undefined);

        prismaMock.settings.findUnique.mockResolvedValue({
            steamApiKey: "key", telegramToken: "token", telegramChatId: "chat",
        });
        prismaMock.game.findMany.mockResolvedValue([]);
        prismaMock.game.create.mockImplementation(async ({ data }: { data: { appId: string } }) => ({
            id: Number(data.appId),
        }));
        (getCompatibilityText as jest.Mock).mockResolvedValue("platinum");
        (getAppDetails as jest.Mock).mockImplementation(async (appId: string) => ({
            name: `Game ${appId}`,
            header_image: "https://cdn/h.jpg",
            categories: [{ id: 2, description: "Single-player" }],
        }));
        (sendTelegramMessage as jest.Mock).mockResolvedValue(true);
    });

    afterEach(() => jest.restoreAllMocks());

    it("sends one digest instead of six cards and records one history row", async () => {
        prismaMock.user.findMany.mockResolvedValue([
            { id: 1, name: "Стас", steamId: "76561", games: [{ appId: "1", notifiedAt: new Date() }] },
        ]);
        (getOwnedGames as jest.Mock).mockResolvedValue([
            { appid: 1 }, { appid: 2 }, { appid: 3 }, { appid: 4 },
            { appid: 5 }, { appid: 6 }, { appid: 7 },
        ]);

        await pollAllUsers();

        expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
        expect((sendTelegramMessage as jest.Mock).mock.calls[0][0]).toContain("сразу 6 новых игр");
        expect(prismaMock.messageHistory.create).toHaveBeenCalledTimes(1);
        expect(prismaMock.messageHistory.create.mock.calls[0][0].data.gameName).toBe("Дайджест: 6 игр");
    });

    it("pins the DIGEST_THRESHOLD boundary: exactly five new games send five cards, not a digest", async () => {
        // The companion "sends one digest instead of six cards..." test above pins the other
        // side of this boundary (six new games -> one digest). This pins `>` staying `>`, not
        // silently becoming `>=`.
        prismaMock.user.findMany.mockResolvedValue([
            { id: 1, name: "Стас", steamId: "76561", games: [{ appId: "1", notifiedAt: new Date() }] },
        ]);
        (getOwnedGames as jest.Mock).mockResolvedValue([
            { appid: 1 }, { appid: 2 }, { appid: 3 }, { appid: 4 }, { appid: 5 }, { appid: 6 },
        ]);

        await pollAllUsers();

        expect(sendTelegramMessage).toHaveBeenCalledTimes(5);
        expect(prismaMock.messageHistory.create).toHaveBeenCalledTimes(5);
        for (const call of prismaMock.messageHistory.create.mock.calls) {
            expect(call[0].data.gameName).not.toContain("Дайджест");
        }
    });

    it("keeps the first sync silent", async () => {
        prismaMock.user.findMany.mockResolvedValue([
            { id: 1, name: "Новый", steamId: "76562", games: [] },
        ]);
        (getOwnedGames as jest.Mock).mockResolvedValue([
            { appid: 1 }, { appid: 2 }, { appid: 3 }, { appid: 4 }, { appid: 5 }, { appid: 6 },
        ]);

        await pollAllUsers();

        expect(sendTelegramMessage).not.toHaveBeenCalled();
        expect(prismaMock.messageHistory.create).not.toHaveBeenCalled();
    });

    it("leaves the whole batch unnotified when the digest send fails, so the retry loop can recover it", async () => {
        prismaMock.user.findMany.mockResolvedValue([
            { id: 1, name: "Стас", steamId: "76561", games: [{ appId: "1", notifiedAt: new Date() }] },
        ]);
        (getOwnedGames as jest.Mock).mockResolvedValue([
            { appid: 1 }, { appid: 2 }, { appid: 3 }, { appid: 4 },
            { appid: 5 }, { appid: 6 }, { appid: 7 },
        ]);
        (sendTelegramMessage as jest.Mock).mockResolvedValue(false);

        await pollAllUsers();

        expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
        for (const call of prismaMock.game.create.mock.calls) {
            expect(call[0].data.notifiedAt).toBeNull();
        }
        expect(prismaMock.game.update).not.toHaveBeenCalled();
        expect(prismaMock.messageHistory.create).not.toHaveBeenCalled();
    });
});
