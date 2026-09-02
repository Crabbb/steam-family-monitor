// FILE: src/__tests__/pricecard.test.ts
// VERSION: 1.0.0

import { getAppDetails } from "../lib/steam";
import { getKztRate } from "../lib/cbr";
import { getPlatiCheapest } from "../lib/plati";
import { buildPriceCard, formatPriceCardHtml, formatWatchlistAlertHtml } from "../lib/pricecard";

jest.mock("../lib/steam", () => ({
    ...jest.requireActual("../lib/steam"),
    getAppDetails: jest.fn(),
}));

jest.mock("../lib/cbr", () => ({
    getKztRate: jest.fn(),
    convertKztToRub: jest.fn((priceKztFinal: number, rate: { kztValue: number; kztNominal: number }) =>
        Math.round((priceKztFinal / 100) * (rate.kztValue / rate.kztNominal))
    ),
}));

jest.mock("../lib/plati", () => ({
    getPlatiCheapest: jest.fn(),
}));

const getAppDetailsMock = getAppDetails as jest.MockedFunction<typeof getAppDetails>;
const getKztRateMock = getKztRate as jest.MockedFunction<typeof getKztRate>;
const getPlatiCheapestMock = getPlatiCheapest as jest.MockedFunction<typeof getPlatiCheapest>;

describe("M-PRICECARD: price aggregation and formatting", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("aggregates RU, KZ, conversion, and Plati data into one card", async () => {
        getAppDetailsMock
            .mockResolvedValueOnce({
                name: "Cyberpunk 2077",
                header_image: "https://cdn/header.jpg",
                price_overview: {
                    final_formatted: "2000 ₽",
                    final: 200000,
                    discount_percent: 50,
                },
            })
            .mockResolvedValueOnce({
                name: "Cyberpunk 2077",
                price_overview: {
                    final_formatted: "10000 ₸",
                    final: 1000000,
                    discount_percent: 0,
                },
            });
        getKztRateMock.mockResolvedValueOnce({ kztValue: 16, kztNominal: 100 });
        getPlatiCheapestMock.mockResolvedValueOnce({
            name: "Cyberpunk 2077 Steam key",
            priceRur: 1500,
            url: "https://plati.market/item",
            numSold: 500,
        });

        const card = await buildPriceCard("1091500");

        expect(card).toMatchObject({
            appId: "1091500",
            name: "Cyberpunk 2077",
            priceRuFormatted: "2000 ₽",
            priceRuFinal: 200000,
            discountPctRu: 50,
            priceKzFormatted: "10000 ₸",
            priceKzFinal: 1000000,
            priceKzInRub: 1600,
            platiPriceRub: 1500,
        });
    });

    it("formats unavailable RU price and alert historical minimums", () => {
        const html = formatWatchlistAlertHtml({
            appId: "123",
            name: "Region Locked Game",
            priceRuFormatted: null,
            priceRuFinal: null,
            discountPctRu: 0,
            discountPctKz: 0,
            priceKzFormatted: "5000 ₸",
            priceKzFinal: 500000,
            priceKzInRub: 800,
            platiName: null,
            platiPriceRub: null,
            platiUrl: null,
            isFree: false,
            familySharing: "unknown",
        }, 150000, 700);

        expect(html).toContain("RU:</b> N/A");
        expect(html).toContain("KZ:</b> 5000 ₸ (~800 ₽)");
        expect(html).toContain("RU: 1500 ₽");
        expect(html).toContain("KZ: ~700 ₽");
    });

    it("formats free games without regional stores", () => {
        const html = formatPriceCardHtml({
            appId: "730",
            name: "Counter-Strike 2",
            priceRuFormatted: null,
            priceRuFinal: null,
            discountPctRu: 0,
            discountPctKz: 0,
            priceKzFormatted: null,
            priceKzFinal: null,
            priceKzInRub: null,
            platiName: null,
            platiPriceRub: null,
            platiUrl: null,
            isFree: true,
            familySharing: "supported",
        });

        expect(html).toContain("Цена:</b> Бесплатно");
    });

    it("reads family sharing support from the RU region", async () => {
        getAppDetailsMock
            .mockResolvedValueOnce({
                name: "Half-Life 2",
                categories: [{ id: 62, description: "Семейный доступ" }],
                price_overview: { final_formatted: "500 ₽", final: 50000, discount_percent: 0 },
            })
            .mockResolvedValueOnce(null);
        getPlatiCheapestMock.mockResolvedValueOnce(null);

        const card = await buildPriceCard("220");

        expect(card?.familySharing).toBe("supported");
    });

    it("falls back to KZ categories for family sharing when RU is region-blocked", async () => {
        getAppDetailsMock
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                name: "Cyberpunk 2077",
                categories: [{ id: 62, description: "Семейный доступ" }],
                price_overview: { final_formatted: "10000 ₸", final: 1000000, discount_percent: 0 },
            })
            .mockResolvedValueOnce({ name: "Cyberpunk 2077" });
        getKztRateMock.mockResolvedValueOnce({ kztValue: 16, kztNominal: 100 });
        getPlatiCheapestMock.mockResolvedValueOnce(null);

        const card = await buildPriceCard("1091500");

        expect(card?.familySharing).toBe("supported");
    });

    it("reports unsupported family sharing when categories exist without it", async () => {
        getAppDetailsMock
            .mockResolvedValueOnce({
                name: "Grand Theft Auto V Legacy",
                categories: [{ id: 2, description: "Для одного игрока" }],
                price_overview: { final_formatted: "1500 ₽", final: 150000, discount_percent: 0 },
            })
            .mockResolvedValueOnce(null);
        getPlatiCheapestMock.mockResolvedValueOnce(null);

        const card = await buildPriceCard("271590");

        expect(card?.familySharing).toBe("unsupported");
    });

    it("reports unknown family sharing when no region returned categories", async () => {
        getAppDetailsMock
            .mockResolvedValueOnce({
                name: "Delisted Game",
                price_overview: { final_formatted: "100 ₽", final: 10000, discount_percent: 0 },
            })
            .mockResolvedValueOnce(null);
        getPlatiCheapestMock.mockResolvedValueOnce(null);

        const card = await buildPriceCard("999");

        expect(card?.familySharing).toBe("unknown");
    });

    it("renders every family sharing state in the price card", () => {
        const base = {
            appId: "1091500",
            name: "Cyberpunk 2077",
            priceRuFormatted: "2000 ₽",
            priceRuFinal: 200000,
            discountPctRu: 0,
            discountPctKz: 0,
            priceKzFormatted: null,
            priceKzFinal: null,
            priceKzInRub: null,
            platiName: null,
            platiPriceRub: null,
            platiUrl: null,
            isFree: false,
        };

        expect(formatPriceCardHtml({ ...base, familySharing: "supported" }))
            .toContain("Семейная библиотека:</b> Доступно");
        expect(formatPriceCardHtml({ ...base, familySharing: "unsupported" }))
            .toContain("Семейная библиотека:</b> Недоступно");
        expect(formatPriceCardHtml({ ...base, familySharing: "unknown" }))
            .toContain("Семейная библиотека:</b> Нет данных");
    });

    it("keeps the family sharing line for free games", () => {
        const html = formatPriceCardHtml({
            appId: "730",
            name: "Counter-Strike 2",
            priceRuFormatted: null,
            priceRuFinal: null,
            discountPctRu: 0,
            discountPctKz: 0,
            priceKzFormatted: null,
            priceKzFinal: null,
            priceKzInRub: null,
            platiName: null,
            platiPriceRub: null,
            platiUrl: null,
            isFree: true,
            familySharing: "unsupported",
        });

        expect(html).toContain("Семейная библиотека:</b> Недоступно");
    });

    it("shows family sharing in watchlist discount alerts", () => {
        const html = formatWatchlistAlertHtml({
            appId: "1091500",
            name: "Cyberpunk 2077",
            priceRuFormatted: "1000 ₽",
            priceRuFinal: 100000,
            discountPctRu: 50,
            discountPctKz: 0,
            priceKzFormatted: null,
            priceKzFinal: null,
            priceKzInRub: null,
            platiName: null,
            platiPriceRub: null,
            platiUrl: null,
            isFree: false,
            familySharing: "supported",
        }, null, null);

        expect(html).toContain("Семейная библиотека:</b> Доступно");
    });

    it("shows which plati listing the price came from", () => {
        const html = formatPriceCardHtml({
            appId: "2651280",
            name: "Marvel Человек-Паук 2",
            priceRuFormatted: null,
            priceRuFinal: null,
            discountPctRu: 0,
            discountPctKz: 0,
            priceKzFormatted: null,
            priceKzFinal: null,
            priceKzInRub: null,
            platiName: "Marvel Человек-Паук 2 steam МИР",
            platiPriceRub: 3850,
            platiUrl: "https://plati.market/itm/4899317",
            isFree: false,
            familySharing: "supported",
        });

        expect(html).toContain("Marvel Человек-Паук 2 steam МИР");
    });

    it("escapes HTML in the plati listing title", () => {
        const html = formatPriceCardHtml({
            appId: "1",
            name: "Game",
            priceRuFormatted: null,
            priceRuFinal: null,
            discountPctRu: 0,
            discountPctKz: 0,
            priceKzFormatted: null,
            priceKzFinal: null,
            priceKzInRub: null,
            platiName: "Key <b>R&D</b>",
            platiPriceRub: 100,
            platiUrl: "https://plati.market/itm/1",
            isFree: false,
            familySharing: "unknown",
        });

        expect(html).toContain("Key &lt;b&gt;R&amp;D&lt;/b&gt;");
        expect(html).not.toContain("Key <b>R&D</b>");
    });

    it("truncates an overlong plati listing title", () => {
        const html = formatPriceCardHtml({
            appId: "1",
            name: "Game",
            priceRuFormatted: null,
            priceRuFinal: null,
            discountPctRu: 0,
            discountPctKz: 0,
            priceKzFormatted: null,
            priceKzFinal: null,
            priceKzInRub: null,
            platiName: "Игра расширенное издание с очень длинным названием лота продавца на плати маркет",
            platiPriceRub: 100,
            platiUrl: "https://plati.market/itm/1",
            isFree: false,
            familySharing: "unknown",
        });

        expect(html).toContain("Игра расширенное издание");
        expect(html).toContain("…");
        expect(html).not.toContain("плати маркет");
    });

    it("reads the KZ discount percent when RU is region-blocked", async () => {
        getAppDetailsMock
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                name: "Marvel Человек-Паук 2",
                price_overview: { final_formatted: "11 749 ₸", final: 1174900, discount_percent: 50 },
            })
            .mockResolvedValueOnce({ name: "Marvel's Spider-Man 2" });
        getKztRateMock.mockResolvedValueOnce({ kztValue: 16, kztNominal: 100 });
        getPlatiCheapestMock.mockResolvedValueOnce(null);

        const card = await buildPriceCard("2651280");

        expect(card?.discountPctRu).toBe(0);
        expect(card?.discountPctKz).toBe(50);
    });

    it("shows the KZ discount in the card", () => {
        const html = formatPriceCardHtml({
            appId: "2651280",
            name: "Marvel Человек-Паук 2",
            priceRuFormatted: null,
            priceRuFinal: null,
            discountPctRu: 0,
            discountPctKz: 50,
            priceKzFormatted: "11 749 ₸",
            priceKzFinal: 1174900,
            priceKzInRub: 2175,
            platiName: null,
            platiPriceRub: null,
            platiUrl: null,
            isFree: false,
            familySharing: "supported",
        });

        expect(html).toContain("KZ:</b> 11 749 ₸ (~2175 ₽) <b>(-50%)</b>");
    });
});
