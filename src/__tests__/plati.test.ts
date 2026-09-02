// FILE: src/__tests__/plati.test.ts
// VERSION: 1.0.0

describe("M-PLATI: cheapest Steam key lookup", () => {
    beforeEach(() => {
        jest.resetModules();
        global.fetch = jest.fn();
        jest.spyOn(console, "log").mockImplementation(() => undefined);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("filters non-Steam offers and chooses the cheapest item among the top sellers", async () => {
        const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            items: [
                { name: "Game account Steam", price_rur: 5, numsold: 1000, url: "/bad", section_id: 1 },
                { name: "Game Steam key A", price_rur: 500, numsold: 100, url: "/a", section_id: 1 },
                { name: "Game Steam key B", price_rur: 300, numsold: 90, url: "/b", section_id: 1 },
                { name: "Game Steam key C", price_rur: 1000, numsold: 80, url: "/c", section_id: 1 },
                { name: "Game Steam key D", price_rur: 250, numsold: 70, url: "/d", section_id: 1 },
                { name: "Game Steam key E", price_rur: 200, numsold: 60, url: "/e", section_id: 1 },
                { name: "Game Steam key F", price_rur: 10, numsold: 1, url: "/f", section_id: 1 },
            ],
        })));

        const { getPlatiCheapest } = await import("../lib/plati");
        const result = await getPlatiCheapest("Game");

        expect(result).toEqual({
            name: "Game Steam key E",
            priceRur: 200,
            url: "https://plati.market/e",
            numSold: 60,
        });
    });

    it("returns null when search results do not contain Steam keys", async () => {
        const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            items: [
                { name: "Game account", price_rur: 100, numsold: 10, url: "/account", section_id: 1 },
                { name: "Game Xbox key", price_rur: 100, numsold: 10, url: "/xbox", section_id: 1 },
            ],
        })));

        const { getPlatiCheapest } = await import("../lib/plati");
        const result = await getPlatiCheapest("Game");

        expect(result).toBeNull();
    });
});
