// FILE: src/__tests__/freePromotions.test.ts
// VERSION: 1.0.0

import { prisma } from "../lib/db";
import { buildDiscountedFreeSearchUrl, getAppDetails, getCompatibilityText, getReviewSummary, searchDiscountedFreeGames } from "../lib/steam";
import { resetSteamHttpState } from "../lib/steamHttp";
import { sendTelegramMessage } from "../lib/telegram";
import {
    checkFreePromotions,
    discoverFreePromotions,
    formatFreePromotionMessage,
    isFreeToKeepPromotion,
} from "../lib/freePromotions";

jest.mock("../lib/db", () => ({
    prisma: {
        settings: { findUnique: jest.fn() },
        freePromotionNotification: {
            findUnique: jest.fn(),
            create: jest.fn(),
        },
        user: {
            count: jest.fn(),
        },
        game: {
            findMany: jest.fn(),
        },
    },
}));

jest.mock("../lib/steam", () => {
    const actual = jest.requireActual("../lib/steam");
    return {
        ...actual,
        getAppDetails: jest.fn(),
        getCompatibilityText: jest.fn(),
        getReviewSummary: jest.fn(),
        searchDiscountedFreeGames: jest.fn(),
    };
});

jest.mock("../lib/telegram", () => ({
    sendTelegramMessage: jest.fn(),
}));

const prismaMock = prisma as unknown as {
    settings: { findUnique: jest.Mock };
    freePromotionNotification: {
        findUnique: jest.Mock;
        create: jest.Mock;
    };
    user: { count: jest.Mock };
    game: { findMany: jest.Mock };
};
const getAppDetailsMock = getAppDetails as jest.MockedFunction<typeof getAppDetails>;
const getCompatibilityTextMock = getCompatibilityText as jest.MockedFunction<typeof getCompatibilityText>;
const getReviewSummaryMock = getReviewSummary as jest.MockedFunction<typeof getReviewSummary>;
const searchDiscountedFreeGamesMock = searchDiscountedFreeGames as jest.MockedFunction<typeof searchDiscountedFreeGames>;
const sendTelegramMessageMock = sendTelegramMessage as jest.MockedFunction<typeof sendTelegramMessage>;

const freeToKeepDetails = {
    name: "Nocturnal",
    type: "game",
    header_image: "https://cdn/header.jpg",
    short_description: "A fast action game.",
    price_overview: {
        currency: "RUB",
        initial: 62000,
        final: 62000,
        discount_percent: 100,
        initial_formatted: "620 руб.",
        final_formatted: "Бесплатно",
    },
    package_groups: [{
        name: "default",
        title: "Купить Nocturnal",
        subs: [{
            packageid: 1621597,
            percent_savings_text: ": -100%",
            option_text: "Nocturnal Limited Free Promotional Package - Apr 2026 - <span>Бесплатно</span>",
            price_in_cents_with_discount: 0,
        }],
    }],
};

describe("M-FREEPROMOS: free-to-keep promotion detection", () => {
    it("builds Steam search URL using discount=100 specials, not maxprice=free F2P listing", () => {
        const url = new URL(buildDiscountedFreeSearchUrl("ru", 0, 100));
        expect(url.searchParams.get("specials")).toBe("1");
        expect(url.searchParams.get("discount")).toBe("100");
        expect(url.searchParams.get("filter")).toBeNull();
        expect(url.searchParams.get("maxprice")).toBeNull();
        expect(url.searchParams.get("cc")).toBe("ru");
    });

    beforeEach(() => {
        jest.clearAllMocks();
        resetSteamHttpState();
        jest.spyOn(console, "log").mockImplementation(() => undefined);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("accepts zero-price promotional packages and rejects free weekends", () => {
        expect(isFreeToKeepPromotion(freeToKeepDetails)).toMatchObject({
            isPromotion: true,
            packageIds: ["1621597"],
        });

        expect(isFreeToKeepPromotion({
            ...freeToKeepDetails,
            package_groups: [{
                name: "default",
                title: "Play for free",
                subs: [{
                    packageid: 123,
                    percent_savings_text: ": -100%",
                    option_text: "Free Weekend - Play For Free until Monday",
                    price_in_cents_with_discount: 0,
                }],
            }],
        })).toEqual({ isPromotion: false, packageIds: [] });
    });

    it("discovers RU and KZ promotions from Steam search and appdetails validation", async () => {
        searchDiscountedFreeGamesMock
            .mockResolvedValueOnce([{ appId: "1634080", name: "Nocturnal" }])
            .mockResolvedValueOnce([{ appId: "1634080", name: "Nocturnal" }]);
        getAppDetailsMock
            .mockResolvedValueOnce(freeToKeepDetails)
            .mockResolvedValueOnce({
                ...freeToKeepDetails,
                price_overview: {
                    currency: "KZT",
                    initial: 700000,
                    final: 700000,
                    discount_percent: 100,
                    initial_formatted: "7 000₸",
                    final_formatted: "Бесплатно",
                },
            });

        const promotions = await discoverFreePromotions({
            regions: ["ru", "kz"],
            searchCount: 100,
        });

        expect(promotions).toHaveLength(1);
        expect(promotions[0]).toMatchObject({
            appId: "1634080",
            name: "Nocturnal",
            promotionKey: "1621597",
            regions: ["ru", "kz"],
        });
        expect(searchDiscountedFreeGamesMock).toHaveBeenCalledWith("ru", 200);
        expect(searchDiscountedFreeGamesMock).toHaveBeenCalledWith("kz", 200);
    });

    it("sends one informative message and records the promotion key", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            telegramToken: "token",
            telegramChatId: "chat",
            freePromosEnabled: true,
            freePromosRegionRu: true,
            freePromosRegionKz: true,
            freePromosSkipOwnedByAll: true,
            freePromosSearchCount: 100,
        });
        searchDiscountedFreeGamesMock
            .mockResolvedValueOnce([{ appId: "1634080", name: "Nocturnal" }])
            .mockResolvedValueOnce([]);
        getAppDetailsMock.mockResolvedValueOnce(freeToKeepDetails);
        getCompatibilityTextMock.mockResolvedValueOnce("Verified / ProtonDB Platinum");
        getReviewSummaryMock.mockResolvedValueOnce("Очень положительные — 94% из 3 806");
        prismaMock.freePromotionNotification.findUnique.mockResolvedValueOnce(null);
        prismaMock.user.count.mockResolvedValueOnce(2);
        prismaMock.game.findMany.mockResolvedValueOnce([{ userId: 1 }]);
        prismaMock.freePromotionNotification.create.mockResolvedValueOnce({});
        sendTelegramMessageMock.mockResolvedValueOnce(true);

        await checkFreePromotions();

        expect(sendTelegramMessageMock).toHaveBeenCalledWith(
            expect.stringContaining("Отзывы Steam:</b> Очень положительные — 94% из 3 806"),
            "chat",
            "token",
            "https://cdn/header.jpg",
        );
        expect(prismaMock.freePromotionNotification.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                appId: "1634080",
                promotionKey: "1621597",
                regions: "ru",
            }),
        });
    });

    it("does not repeat an already recorded promotion key", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            telegramToken: "token",
            telegramChatId: "chat",
            freePromosEnabled: true,
            freePromosRegionRu: true,
            freePromosRegionKz: false,
            freePromosSkipOwnedByAll: false,
            freePromosSearchCount: 100,
        });
        searchDiscountedFreeGamesMock.mockResolvedValueOnce([{ appId: "1634080", name: "Nocturnal" }]);
        getAppDetailsMock.mockResolvedValueOnce(freeToKeepDetails);
        prismaMock.freePromotionNotification.findUnique.mockResolvedValueOnce({ id: 1 });

        await checkFreePromotions();

        expect(sendTelegramMessageMock).not.toHaveBeenCalled();
        expect(prismaMock.freePromotionNotification.create).not.toHaveBeenCalled();
    });

    it("skips games already owned by all monitored users", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce({
            telegramToken: "token",
            telegramChatId: "chat",
            freePromosEnabled: true,
            freePromosRegionRu: true,
            freePromosRegionKz: false,
            freePromosSkipOwnedByAll: true,
            freePromosSearchCount: 100,
        });
        searchDiscountedFreeGamesMock.mockResolvedValueOnce([{ appId: "1634080", name: "Nocturnal" }]);
        getAppDetailsMock.mockResolvedValueOnce(freeToKeepDetails);
        prismaMock.freePromotionNotification.findUnique.mockResolvedValueOnce(null);
        prismaMock.user.count.mockResolvedValueOnce(2);
        prismaMock.game.findMany.mockResolvedValueOnce([{ userId: 1 }, { userId: 2 }]);

        await checkFreePromotions();

        expect(sendTelegramMessageMock).not.toHaveBeenCalled();
        expect(prismaMock.freePromotionNotification.create).not.toHaveBeenCalled();
    });

    it("formats Telegram HTML with regional availability and required links", () => {
        const html = formatFreePromotionMessage({
            appId: "1634080",
            name: "Nocturnal",
            headerImage: "https://cdn/header.jpg",
            shortDescription: "A fast action game.",
            promotionKey: "1621597",
            regions: ["ru", "kz"],
            regional: {
                ru: {
                    packageIds: ["1621597"],
                    originalFormatted: "620 руб.",
                    finalFormatted: "Бесплатно",
                },
                kz: {
                    packageIds: ["1621597"],
                    originalFormatted: "7 000₸",
                    finalFormatted: "Бесплатно",
                },
            },
            compatibilityText: "Verified / ProtonDB Platinum",
            reviewSummaryText: "Очень положительные — 94% из 3 806",
        });

        expect(html).toContain("Бесплатно навсегда");
        expect(html).toContain("RU:</b> 620 руб. → Бесплатно");
        expect(html).toContain("KZ:</b> 7 000₸ → Бесплатно");
        expect(html).toContain("https://store.steampowered.com/app/1634080");
        expect(html).toContain("https://steamdb.info/app/1634080/");
        expect(html).toContain("https://www.protondb.com/app/1634080");
        expect(html).toContain("Verified / ProtonDB Platinum");
        expect(html).toContain("Отзывы Steam:</b> Очень положительные — 94% из 3 806");
        expect(html).toContain("не бесплатные выходные");
    });
});
