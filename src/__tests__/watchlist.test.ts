// FILE: src/__tests__/watchlist.test.ts
// VERSION: 1.0.0

import { prisma } from "../lib/db";
import { buildPriceCard, formatWatchlistAlertHtml } from "../lib/pricecard";
import { sendTelegramMessage } from "../lib/telegram";
import { checkWatchlistPrices } from "../lib/watchlist";

jest.mock("../lib/db", () => ({
    prisma: {
        settings: {
            findUnique: jest.fn(),
        },
        watchedGame: {
            findMany: jest.fn(),
            update: jest.fn(),
        },
        priceHistory: {
            create: jest.fn(),
            aggregate: jest.fn(),
        },
    },
}));

jest.mock("../lib/pricecard", () => ({
    buildPriceCard: jest.fn(),
    formatWatchlistAlertHtml: jest.fn(),
}));

jest.mock("../lib/telegram", () => ({
    sendTelegramMessage: jest.fn(),
}));

const prismaMock = prisma as unknown as {
    settings: { findUnique: jest.Mock };
    watchedGame: {
        findMany: jest.Mock;
        update: jest.Mock;
    };
    priceHistory: {
        create: jest.Mock;
        aggregate: jest.Mock;
    };
};
const buildPriceCardMock = buildPriceCard as jest.MockedFunction<typeof buildPriceCard>;
const formatWatchlistAlertHtmlMock = formatWatchlistAlertHtml as jest.MockedFunction<typeof formatWatchlistAlertHtml>;
const sendTelegramMessageMock = sendTelegramMessage as jest.MockedFunction<typeof sendTelegramMessage>;

describe("M-WATCHLIST: scheduled discount checks", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        jest.spyOn(console, "log").mockImplementation(() => undefined);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it("records price history and sends an alert when a discount appears", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            telegramToken: "token",
            telegramChatId: "default-chat",
        });
        prismaMock.watchedGame.findMany.mockResolvedValueOnce([{
            id: 1,
            appId: "1091500",
            name: "Cyberpunk 2077",
            chatId: "web",
            lastDiscountPct: 0,
        }]);
        buildPriceCardMock.mockResolvedValueOnce({
            appId: "1091500",
            name: "Cyberpunk 2077",
            headerImage: "https://cdn/header.jpg",
            priceRuFormatted: "1000 ₽",
            priceRuFinal: 100000,
            discountPctRu: 50,
            priceKzFormatted: "5000 ₸",
            priceKzFinal: 500000,
            priceKzInRub: 800,
            platiName: null,
            platiPriceRub: null,
            platiUrl: null,
            isFree: false,
            familySharing: "supported",
        });
        prismaMock.priceHistory.aggregate.mockResolvedValueOnce({
            _min: { priceRuFinal: 90000, priceKzInRub: 700 },
        });
        formatWatchlistAlertHtmlMock.mockReturnValueOnce("<b>alert</b>");
        sendTelegramMessageMock.mockResolvedValueOnce(true);

        const check = checkWatchlistPrices();
        await jest.runAllTimersAsync();
        await check;

        expect(prismaMock.priceHistory.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                appId: "1091500",
                discountPct: 50,
                watchedGameId: 1,
            }),
        });
        expect(formatWatchlistAlertHtmlMock).toHaveBeenCalledWith(expect.objectContaining({
            appId: "1091500",
        }), 90000, 700);
        expect(sendTelegramMessageMock).toHaveBeenCalledWith("<b>alert</b>", "default-chat", "token", "https://cdn/header.jpg");
        expect(prismaMock.watchedGame.update).toHaveBeenCalledWith({
            where: { id: 1 },
            data: { lastDiscountPct: 50 },
        });
    });

    it("skips checks when Telegram token is missing", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({ telegramToken: "" });

        await checkWatchlistPrices();

        expect(prismaMock.watchedGame.findMany).not.toHaveBeenCalled();
    });
});
