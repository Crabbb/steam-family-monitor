// FILE: src/__tests__/core.polling.test.ts
// VERSION: 1.0.0

import { prisma } from "../lib/db";
import { getOwnedGames, getAppDetails, getAppNameFallback, getCompatibilityText } from "../lib/steam";
import { sendTelegramMessage } from "../lib/telegram";
import { getKztRate, convertKztToRub } from "../lib/cbr";
import { pollAllUsers } from "../lib/core";

jest.mock("../lib/db", () => ({
    prisma: {
        settings: {
            findUnique: jest.fn(),
        },
        user: {
            findMany: jest.fn(),
        },
        game: {
            create: jest.fn(),
        },
        messageHistory: {
            create: jest.fn(),
        },
    },
}));

jest.mock("../lib/steam", () => ({
    ...jest.requireActual("../lib/steam"),
    getOwnedGames: jest.fn(),
    getAppDetails: jest.fn(),
    getAppNameFallback: jest.fn(),
    getCompatibilityText: jest.fn(),
}));

jest.mock("../lib/telegram", () => ({
    sendTelegramMessage: jest.fn(),
}));

jest.mock("../lib/cbr", () => ({
    getKztRate: jest.fn(),
    convertKztToRub: jest.fn(),
}));

const prismaMock = prisma as unknown as {
    settings: { findUnique: jest.Mock };
    user: { findMany: jest.Mock };
    game: { create: jest.Mock };
    messageHistory: { create: jest.Mock };
};
const getOwnedGamesMock = getOwnedGames as jest.MockedFunction<typeof getOwnedGames>;
const getAppDetailsMock = getAppDetails as jest.MockedFunction<typeof getAppDetails>;
const getAppNameFallbackMock = getAppNameFallback as jest.MockedFunction<typeof getAppNameFallback>;
const getCompatibilityTextMock = getCompatibilityText as jest.MockedFunction<typeof getCompatibilityText>;
const sendTelegramMessageMock = sendTelegramMessage as jest.MockedFunction<typeof sendTelegramMessage>;
const getKztRateMock = getKztRate as jest.MockedFunction<typeof getKztRate>;
const convertKztToRubMock = convertKztToRub as jest.MockedFunction<typeof convertKztToRub>;

describe("M-CORE: polling regional fallback", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "log").mockImplementation(() => undefined);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
        jest.spyOn(console, "error").mockImplementation(() => undefined);

        prismaMock.settings.findUnique.mockResolvedValue({
            steamApiKey: "steam-key",
            telegramToken: "telegram-token",
            telegramChatId: "chat-id",
        });
        prismaMock.user.findMany.mockResolvedValue([
            {
                id: 1,
                name: "Стас",
                steamId: "steam-id",
                games: [{ appId: "10" }],
            },
        ]);
        prismaMock.game.create.mockResolvedValue({});
        prismaMock.messageHistory.create.mockResolvedValue({});
        getOwnedGamesMock.mockResolvedValue([{ appid: 10 }, { appid: 3357650 }]);
        getCompatibilityTextMock.mockResolvedValue("Playable / ProtonDB Gold");
        getKztRateMock.mockResolvedValue({ kztValue: 16.18, kztNominal: 100 });
        convertKztToRubMock.mockReturnValue(3560);
        sendTelegramMessageMock.mockResolvedValue(true);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("sends full KZ details when a new game is unavailable in RU", async () => {
        getAppDetailsMock.mockImplementation(async (appId, cc = "ru") => {
            if (appId !== "3357650") return null;
            if (cc === "kz") {
                return {
                    name: "PRAGMATA",
                    header_image: "https://cdn/pragmata.jpg",
                    short_description: "A sci-fi action adventure.",
                    price_overview: {
                        final_formatted: "21 999₸",
                        final: 2199900,
                        discount_percent: 0,
                    },
                    categories: [
                        { id: 2, description: "Для одного игрока" },
                        { id: 62, description: "Семейный доступ" },
                    ],
                };
            }
            return null;
        });
        getAppNameFallbackMock.mockResolvedValue("PRAGMATA");

        await pollAllUsers();

        expect(getAppDetailsMock).toHaveBeenCalledWith("3357650", "ru");
        expect(getAppDetailsMock).toHaveBeenCalledWith("3357650", "kz");
        expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
        const [html, chatId, token, imageUrl] = sendTelegramMessageMock.mock.calls[0];
        expect(chatId).toBe("chat-id");
        expect(token).toBe("telegram-token");
        expect(imageUrl).toBe("https://cdn/pragmata.jpg");
        expect(html).toContain("PRAGMATA");
        expect(html).toContain("Playable / ProtonDB Gold");
        expect(html).toContain("🇷🇺 <b>RU:</b> Недоступно");
        expect(html).toContain("🇰🇿 <b>KZ:</b> 21 999₸ / ~3560 ₽");
        expect(html).not.toContain("Информация об игре недоступна");
        expect(prismaMock.messageHistory.create).toHaveBeenCalledWith({
            data: {
                userName: "Стас",
                gameName: "PRAGMATA",
                isTest: false,
            },
        });
    });
});
