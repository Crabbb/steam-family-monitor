// FILE: src/__tests__/watchlist.regions.test.ts
// VERSION: 1.0.0

import { prisma } from "../lib/db";
import { buildPriceCard, formatWatchlistAlertHtml } from "../lib/pricecard";
import { sendTelegramMessage } from "../lib/telegram";
import { checkWatchlistPrices } from "../lib/watchlist";

jest.mock("../lib/db", () => ({
    prisma: {
        settings: { findUnique: jest.fn() },
        watchedGame: { findMany: jest.fn(), update: jest.fn() },
        priceHistory: { create: jest.fn(), aggregate: jest.fn() },
    },
}));

jest.mock("../lib/pricecard", () => ({
    buildPriceCard: jest.fn(),
    formatWatchlistAlertHtml: jest.fn(),
}));

jest.mock("../lib/telegram", () => ({ sendTelegramMessage: jest.fn() }));

const prismaMock = prisma as unknown as {
    settings: { findUnique: jest.Mock };
    watchedGame: { findMany: jest.Mock; update: jest.Mock };
    priceHistory: { create: jest.Mock; aggregate: jest.Mock };
};
const buildPriceCardMock = buildPriceCard as jest.MockedFunction<typeof buildPriceCard>;
const formatWatchlistAlertHtmlMock = formatWatchlistAlertHtml as jest.MockedFunction<typeof formatWatchlistAlertHtml>;
const sendTelegramMessageMock = sendTelegramMessage as jest.MockedFunction<typeof sendTelegramMessage>;

// checkWatchlistPrices ждёт секунду между играми. Без fake timers каждый кейс
// простаивает это время вживую, поэтому вызов везде драйвится так:
//   const check = checkWatchlistPrices(); await jest.runAllTimersAsync(); await check;
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

describe("M-WATCHLIST: discounts are regional", () => {
    it("alerts on a KZ discount when the game is region-blocked in RU", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            telegramToken: "token", telegramChatId: "chat", watchlistEnabled: true, watchlistMinDiscountPct: 10,
        });
        prismaMock.watchedGame.findMany.mockResolvedValueOnce([{
            id: 1, appId: "2651280", name: "Marvel Человек-Паук 2", chatId: "web",
            lastDiscountPct: 0, lastDiscountPctKz: 0,
        }]);
        buildPriceCardMock.mockResolvedValueOnce({
            appId: "2651280", name: "Marvel Человек-Паук 2",
            priceRuFormatted: null, priceRuFinal: null, discountPctRu: 0,
            priceKzFormatted: "11 749 ₸", priceKzFinal: 1174900, priceKzInRub: 2175, discountPctKz: 50,
            platiName: null, platiPriceRub: null, platiUrl: null,
            isFree: false, familySharing: "supported",
        });
        prismaMock.priceHistory.aggregate.mockResolvedValueOnce({
            _min: { priceRuFinal: null, priceKzInRub: 2500 },
        });
        formatWatchlistAlertHtmlMock.mockReturnValueOnce("<b>alert</b>");
        sendTelegramMessageMock.mockResolvedValueOnce(true);

        const check = checkWatchlistPrices();
        await jest.runAllTimersAsync();
        await check;

        expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
        expect(formatWatchlistAlertHtmlMock).toHaveBeenCalledWith(
            expect.anything(), null, 2500, ["KZ"],
        );
        expect(prismaMock.watchedGame.update).toHaveBeenCalledWith(expect.objectContaining({
            data: { lastDiscountPct: 0, lastDiscountPctKz: 50 },
        }));
    });

    it("does not alert twice for the same KZ discount", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            telegramToken: "token", telegramChatId: "chat", watchlistEnabled: true, watchlistMinDiscountPct: 10,
        });
        prismaMock.watchedGame.findMany.mockResolvedValueOnce([{
            id: 1, appId: "2651280", name: "Marvel Человек-Паук 2", chatId: "web",
            lastDiscountPct: 0, lastDiscountPctKz: 50,
        }]);
        buildPriceCardMock.mockResolvedValueOnce({
            appId: "2651280", name: "Marvel Человек-Паук 2",
            priceRuFormatted: null, priceRuFinal: null, discountPctRu: 0,
            priceKzFormatted: "11 749 ₸", priceKzFinal: 1174900, priceKzInRub: 2175, discountPctKz: 50,
            platiName: null, platiPriceRub: null, platiUrl: null,
            isFree: false, familySharing: "supported",
        });

        const check = checkWatchlistPrices();
        await jest.runAllTimersAsync();
        await check;

        expect(sendTelegramMessageMock).not.toHaveBeenCalled();
        // The silent path must still persist both regions' current values — otherwise this test
        // would pass equally for code that "correctly saw no change" and for code that never
        // looked at KZ at all (the pre-fix bug). Pinning the update call discriminates the two.
        expect(prismaMock.watchedGame.update).toHaveBeenCalledWith(expect.objectContaining({
            data: { lastDiscountPct: 0, lastDiscountPctKz: 50 },
        }));
    });

    it("alerts on a KZ discount even when lastDiscountPctKz is absent from the row", async () => {
        // Simulates a stale Prisma client, a select() projection that drops the column, or a row
        // written outside the ORM: the field is missing (undefined), not merely 0. `undefined < n`
        // is always false in JS, so without normalization this would silently disable the KZ branch
        // forever — reintroducing exactly the bug this plan fixes, and failing toward silence.
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            telegramToken: "token", telegramChatId: "chat", watchlistEnabled: true, watchlistMinDiscountPct: 10,
        });
        prismaMock.watchedGame.findMany.mockResolvedValueOnce([{
            id: 4, appId: "999999", name: "No Man's Sky", chatId: "web",
            lastDiscountPct: 0,
            // lastDiscountPctKz intentionally omitted — not present on the row at all.
        }]);
        buildPriceCardMock.mockResolvedValueOnce({
            appId: "999999", name: "No Man's Sky",
            priceRuFormatted: null, priceRuFinal: null, discountPctRu: 0,
            priceKzFormatted: "8 999 ₸", priceKzFinal: 899900, priceKzInRub: 1660, discountPctKz: 40,
            platiName: null, platiPriceRub: null, platiUrl: null,
            isFree: false, familySharing: "supported",
        });
        prismaMock.priceHistory.aggregate.mockResolvedValueOnce({
            _min: { priceRuFinal: null, priceKzInRub: 1900 },
        });
        formatWatchlistAlertHtmlMock.mockReturnValueOnce("<b>alert</b>");
        sendTelegramMessageMock.mockResolvedValueOnce(true);

        const check = checkWatchlistPrices();
        await jest.runAllTimersAsync();
        await check;

        expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
        expect(formatWatchlistAlertHtmlMock).toHaveBeenCalledWith(
            expect.anything(), null, 1900, ["KZ"],
        );
        expect(prismaMock.watchedGame.update).toHaveBeenCalledWith(expect.objectContaining({
            data: { lastDiscountPct: 0, lastDiscountPctKz: 40 },
        }));
    });

    it("still alerts on an RU discount", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            telegramToken: "token", telegramChatId: "chat", watchlistEnabled: true, watchlistMinDiscountPct: 10,
        });
        prismaMock.watchedGame.findMany.mockResolvedValueOnce([{
            id: 2, appId: "1091500", name: "Cyberpunk 2077", chatId: "web",
            lastDiscountPct: 0, lastDiscountPctKz: 0,
        }]);
        buildPriceCardMock.mockResolvedValueOnce({
            appId: "1091500", name: "Cyberpunk 2077",
            priceRuFormatted: "1000 ₽", priceRuFinal: 100000, discountPctRu: 50,
            priceKzFormatted: null, priceKzFinal: null, priceKzInRub: null, discountPctKz: 0,
            platiName: null, platiPriceRub: null, platiUrl: null,
            isFree: false, familySharing: "supported",
        });
        prismaMock.priceHistory.aggregate.mockResolvedValueOnce({
            _min: { priceRuFinal: 90000, priceKzInRub: null },
        });
        formatWatchlistAlertHtmlMock.mockReturnValueOnce("<b>alert</b>");
        sendTelegramMessageMock.mockResolvedValueOnce(true);

        const check = checkWatchlistPrices();
        await jest.runAllTimersAsync();
        await check;

        expect(formatWatchlistAlertHtmlMock).toHaveBeenCalledWith(expect.anything(), 90000, null, ["RU"]);
    });
});
