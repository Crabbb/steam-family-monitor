// FILE: src/__tests__/steam.test.ts
// VERSION: 1.0.0

import {
    detectFamilySharing,
    getAchievementSchema,
    getAppDetails,
    getAppNameFallback,
    getCompatibilityText,
    getGlobalAchievementPercentages,
    getOwnedGames,
    getPlayerAchievements,
    getProtonTier,
    getRecentlyPlayedGames,
    getReviewSummary,
    searchDiscountedFreeGames,
    searchSteamGames,
} from "../lib/steam";
import { resetSteamHttpState } from "../lib/steamHttp";

// Mock global fetch
global.fetch = jest.fn();

describe("M-STEAM: Steam API Client", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        resetSteamHttpState();
        jest.spyOn(console, "log").mockImplementation(() => undefined);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it("getOwnedGames should fetch and parse the list of app ids", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                response: {
                    game_count: 2,
                    games: [{ appid: 10 }, { appid: 20 }],
                }
            })
        });

        const games = await getOwnedGames("test-steam-id", "test-api-key");
        expect(games.length).toBe(2);
        expect(games[0].appid).toBe(10);
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining("IPlayerService/GetOwnedGames/v0001")
        );
    });

    it("getRecentlyPlayedGames should fetch recent app ids and playtime", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                response: {
                    total_count: 1,
                    games: [{ appid: 1245620, playtime_2weeks: 2372, playtime_forever: 2835 }],
                }
            })
        });

        const games = await getRecentlyPlayedGames("test-steam-id", "test-api-key", 100);

        expect(games).toEqual([{ appid: 1245620, playtime_2weeks: 2372, playtime_forever: 2835 }]);
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("IPlayerService/GetRecentlyPlayedGames/v0001"));
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("count=100"));
    });

    it("getAppDetails should fetch pricing and details", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                "10": {
                    success: true,
                    data: {
                        name: "Test Game",
                        price_overview: {
                            final_formatted: "100 ₽"
                        }
                    }
                }
            })
        });

        const details = await getAppDetails("10");
        expect(details).not.toBeNull();
        expect(details!.name).toBe("Test Game");
        expect(details!.price_overview?.final_formatted).toBe("100 ₽");
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining("appdetails")
        );
    });

    it("getAppNameFallback should return name from SteamSpy", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                appid: "1238860",
                name: "Delisted Game Name",
            })
        });

        const name = await getAppNameFallback("1238860");
        expect(name).toBe("Delisted Game Name");
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining("steamspy.com")
        );
    });

    it("getAppNameFallback should return null when SteamSpy has no data", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                appid: "9999999",
                name: "9999999",
            })
        });

        const name = await getAppNameFallback("9999999");
        expect(name).toBeNull();
    });

    it("getAppNameFallback should return null on network error", async () => {
        jest.useFakeTimers();
        (global.fetch as jest.Mock).mockRejectedValue(new Error("Network error"));

        const pending = getAppNameFallback("1238860");
        await jest.advanceTimersByTimeAsync(1500);
        const name = await pending;

        expect(name).toBeNull();
    });

    it("getProtonTier should prefer tier from ProtonDB summaries", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ tier: "gold", bestReportedTier: "silver" }),
        });

        const tier = await getProtonTier("1091500");

        expect(tier).toBe("gold");
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("protondb.com/api/v1/reports/summaries/1091500"));
    });

    it("getCompatibilityText should combine official Steam Deck status with ProtonDB tier", async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    success: 1,
                    results: { resolved_category: 2 },
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ tier: "gold", bestReportedTier: "silver" }),
            });

        const compatibility = await getCompatibilityText("978520");

        expect(compatibility).toBe("Playable / ProtonDB Gold");
        expect(global.fetch).toHaveBeenNthCalledWith(1, expect.stringContaining("ajaxgetdeckappcompatibilityreport?nAppID=978520"));
        expect(global.fetch).toHaveBeenNthCalledWith(2, expect.stringContaining("protondb.com/api/v1/reports/summaries/978520"));
    });

    it("getReviewSummary should format Steam review description, positive percent and total count", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                success: 1,
                query_summary: {
                    review_score_desc: "Very Positive",
                    total_positive: 3573,
                    total_negative: 233,
                    total_reviews: 3806,
                },
            }),
        });

        const summary = await getReviewSummary("1634080");

        expect(summary).toBe("Очень положительные — 94% из 3 806");
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("store.steampowered.com/appreviews/1634080"));
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("language=all"));
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("purchase_type=all"));
    });

    it("getReviewSummary should return null when Steam has no user reviews", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                success: 1,
                query_summary: {
                    review_score_desc: "No user reviews",
                    total_positive: 0,
                    total_negative: 0,
                    total_reviews: 0,
                },
            }),
        });

        await expect(getReviewSummary("323090")).resolves.toBeNull();
    });

    it("getPlayerAchievements should fetch player achievement progress", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                playerstats: {
                    gameName: "Nocturnal",
                    success: true,
                    achievements: [{ apiname: "DONE", achieved: 1, unlocktime: 123 }],
                },
            }),
        });

        const achievements = await getPlayerAchievements("1634080", "7656", "key");

        expect(achievements).toEqual({
            gameName: "Nocturnal",
            achievements: [{ apiname: "DONE", achieved: 1, unlocktime: 123 }],
        });
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("GetPlayerAchievements"));
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("appid=1634080"));
    });

    it("getPlayerAchievements should quietly return null for apps without public achievement stats", async () => {
        // "This app has no achievements" is a normal, high-volume answer (the service polls many
        // apps that simply don't support achievements) and must stay fully silent — restored via
        // steamFetchJson's onHttpError, which getPlayerAchievements supplies specifically so a 400
        // here never warns (only a 403 does, see the next test).
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => "{}",
            json: async () => ({}),
        });

        const achievements = await getPlayerAchievements("10", "7656", "key");

        expect(achievements).toBeNull();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it("getPlayerAchievements should log private-profile 403 errors with Steam's reason", async () => {
        // The gateway reads the failure body defensively (res.text()) and hands it to
        // onHttpError, which parses it itself — the specific "Profile is not public" reason
        // Steam attaches to a 403 is restored exactly as it was before routing through the
        // gateway.
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: false,
            status: 403,
            statusText: "Forbidden",
            text: async () => JSON.stringify({ playerstats: { success: false, error: "Profile is not public" } }),
            json: async () => ({ playerstats: { success: false, error: "Profile is not public" } }),
        });

        const achievements = await getPlayerAchievements("1245620", "7656", "key");

        expect(achievements).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith("[M-STEAM] GetPlayerAchievements HTTP 403 for app 1245620: Profile is not public");
    });

    it("getAchievementSchema should fetch achievement metadata", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                game: {
                    gameName: "Nocturnal",
                    availableGameStats: {
                        achievements: [{ name: "DONE", displayName: "Done" }],
                    },
                },
            }),
        });

        const schema = await getAchievementSchema("1634080", "key");

        expect(schema).toEqual({
            gameName: "Nocturnal",
            achievements: [{ name: "DONE", displayName: "Done" }],
        });
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("GetSchemaForGame"));
    });

    it("getGlobalAchievementPercentages should fetch global achievement rarity", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                achievementpercentages: {
                    achievements: [{ name: "DONE", percent: 4.2 }],
                },
            }),
        });

        const percentages = await getGlobalAchievementPercentages("1634080");

        expect(percentages).toEqual([{ name: "DONE", percent: 4.2 }]);
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("GetGlobalAchievementPercentagesForApp"));
    });

    it("searchSteamGames should pass numeric app ids through without HTTP lookup", async () => {
        const results = await searchSteamGames(" 730 ");

        expect(results).toEqual([{ appId: "730", name: "" }]);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("searchSteamGames should map Steam store search results", async () => {
        // searchSteamGames now fetches through steamFetchText (the gateway's HTML-endpoint door),
        // so the mock must supply text(), not json() — the function does its own JSON.parse.
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                items: [
                    { id: 1091500, name: "Cyberpunk 2077" },
                    { id: 292030, name: "The Witcher 3" },
                ],
            }),
        });

        const results = await searchSteamGames("cyberpunk", 1);

        expect(results).toEqual([{ appId: "1091500", name: "Cyberpunk 2077" }]);
    });

    it("searchDiscountedFreeGames should parse 100 percent game candidates from Steam search HTML", async () => {
        // searchDiscountedFreeGames now fetches through steamFetchText, so the mock supplies
        // text() with the same JSON-with-embedded-HTML body, parsed by the function itself.
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                results_html: `
                    <a href="https://store.steampowered.com/app/1634080/Nocturnal/"
                       data-ds-appid="1634080" data-ds-itemkey="App_1634080">
                        <span class="title">Nocturnal</span>
                        <div class="discount_pct">-100%</div>
                    </a>
                    <a href="https://store.steampowered.com/app/1/Other/"
                       data-ds-appid="1" data-ds-itemkey="App_1">
                        <span class="title">Other</span>
                        <div class="discount_pct">-50%</div>
                    </a>
                `,
            }),
        });

        const results = await searchDiscountedFreeGames("ru", 50);

        expect(results).toEqual([{ appId: "1634080", name: "Nocturnal" }]);
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("specials=1"));
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("discount=100"));
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("category1=998"));
    });

    it("searchDiscountedFreeGames should scan paged free specials but return only 100 percent discounts", async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    results_html: `
                        <a href="https://store.steampowered.com/app/730/CounterStrike_2/"
                           data-ds-appid="730" data-ds-itemkey="App_730">
                            <span class="title">Counter-Strike 2</span>
                            <div class="discount_block no_discount search_discount_block">
                                <div class="discount_prices">
                                    <div class="discount_final_price free">Free</div>
                                </div>
                            </div>
                        </a>
                    `,
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    results_html: `
                        <a href="https://store.steampowered.com/app/3550490/Overcome_Your_Fears__Caretaker/"
                           data-ds-appid="3550490" data-ds-itemkey="App_3550490">
                            <span class="title">Overcome Your Fears - Caretaker</span>
                            <div class="discount_block search_discount_block" data-price-final="0" data-discount="100"
                                 aria-label="100% off. 240 руб normally, discounted to 0 руб">
                                <div class="discount_pct">-100%</div>
                                <div class="discount_prices">
                                    <div class="discount_original_price">240 руб</div>
                                    <div class="discount_final_price">0 руб</div>
                                </div>
                            </div>
                        </a>
                    `,
                }),
            });

        const results = await searchDiscountedFreeGames("ru", 200);

        expect(results).toEqual([
            { appId: "3550490", name: "Overcome Your Fears - Caretaker" },
        ]);
        expect(global.fetch).toHaveBeenNthCalledWith(1, expect.stringContaining("start=0"));
        expect(global.fetch).toHaveBeenNthCalledWith(2, expect.stringContaining("start=100"));
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("specials=1"));
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("discount=100"));
    });
});

describe("M-STEAM: family sharing detection", () => {
    it("reports supported when the Steam family sharing category is present", () => {
        const details = {
            name: "Cyberpunk 2077",
            categories: [
                { id: 2, description: "Для одного игрока" },
                { id: 62, description: "Семейный доступ" },
            ],
        };

        expect(detectFamilySharing(details)).toBe("supported");
    });

    it("reports supported when only the localized description matches", () => {
        const details = {
            name: "Some Game",
            categories: [{ id: 999, description: "Family Sharing" }],
        };

        expect(detectFamilySharing(details)).toBe("supported");
    });

    it("reports unsupported when categories are known but family sharing is absent", () => {
        const details = {
            name: "Grand Theft Auto V Legacy",
            categories: [
                { id: 2, description: "Для одного игрока" },
                { id: 23, description: "Steam Cloud" },
            ],
        };

        expect(detectFamilySharing(details)).toBe("unsupported");
    });

    it("reports unknown when the app details carry no categories", () => {
        expect(detectFamilySharing({ name: "App 1091500" })).toBe("unknown");
    });

    it("reports unknown when the region returned no app details at all", () => {
        expect(detectFamilySharing(null)).toBe("unknown");
    });
});
