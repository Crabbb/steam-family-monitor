// FILE: src/__tests__/plati.dlc.test.ts
// VERSION: 1.0.0
// Fixture below is the real plati.io response for "Marvel Человек-Паук 2" (31.08.2026),
// trimmed to the fields plati.ts reads; the description is kept only for the listing that
// was wrongly reported as the base-game price in the channel.

const SPIDERMAN_ITEMS = [
        {
                name: "🔴Marvel’s Spider-Man 2 Человек Паук 2🎮PS5 PS TR|UA",
                name_eng: "🔴Marvel's Spider-Man 2 🎮 TR|UA PS5 PS",
                price_rur: 5770,
                numsold: 56,
                url: "https://plati.market/itm/3787939",
                section_id: 20887
        },
        {
                name: "Marvel’s Spider-Man 2 / Человек-паук 2⚡PS5⚡Ru озвучка",
                name_eng: "Marvel's Spider-Man 2 / Spider-Man 2 ⚡ PS5 ⚡ Ru voice",
                price_rur: 5800,
                numsold: 0,
                url: "https://plati.market/itm/4395522",
                section_id: 20887
        },
        {
                name: "💚 Marvel's Человек-паук 2 PS (PS5) 💚",
                name_eng: "💚 Marvel’s Spider-Man 2 PS (PS5) 💚",
                price_rur: 10599,
                numsold: 0,
                url: "https://plati.market/itm/4744412",
                section_id: 20887
        },
        {
                name: "MARVEL ЧЕЛОВЕК-ПАУК 2・DIGITAL DELUXE・ВСЕ DLC・STEAM",
                name_eng: "MARVEL'S SPIDER-MAN 2 DIGITAL DELUXE MARVEL´ S",
                price_rur: 100,
                numsold: 47,
                url: "https://plati.market/itm/4898285",
                section_id: 22764
        },
        {
                name: "MARVEL ЧЕЛОВЕК-ПАУК 2・DIGITAL DELUXE・ВСЕ DLC・STEAM・",
                name_eng: "MARVEL'S SPIDER-MAN 2・DIGITAL DELUXE・ALL DLC・STEAM・",
                price_rur: 100,
                numsold: 8,
                url: "https://plati.market/itm/4898599",
                section_id: 22764
        },
        {
                name: "🎁Marvel Человек-Паук 2 steam🌍МИР",
                name_eng: "🎁Marvel's Spider-Man 2 steam🌍МИР",
                price_rur: 3850,
                numsold: 32,
                url: "https://plati.market/itm/4899317",
                section_id: 20887
        },
        {
                name: "Marvel Человек-Паук 2 * TR/AR * STEAM 🚀 АВТОДОСТАВКА",
                name_eng: "Marvel's Spider-Man 2 * TR/AR * STEAM 🚀 AUTO DELIVERY",
                price_rur: 5275,
                numsold: 13,
                url: "https://plati.market/itm/4899521",
                section_id: 20887
        },
        {
                name: "✅Marvel Человек-Паук 2🎁Steam🌐АВТО ( Только регион UA)",
                name_eng: "✅Marvel's Spider-Man 2🎁Steam🌐AUTO ( Only region UA)",
                price_rur: 4150,
                numsold: 0,
                url: "https://plati.market/itm/4903747",
                section_id: 20887
        },
        {
                name: "Marvel Человек-Паук 2 STEAM НЕ ДЛЯ РФ ⚡️АВТОДОСТАВКА",
                name_eng: "Marvel's Spider-Man 2 STEAM NOT RUS ⚡️AUTODELIVERY 💳0%",
                price_rur: 4262,
                numsold: 5,
                url: "https://plati.market/itm/4903828",
                section_id: 20887
        },
        {
                name: "Цифровое расширенное издание Marvel’s Человек-Паук 2 steam",
                name_eng: "Marvel's Spider-Man 2 Digital Deluxe Edition steam",
                price_rur: 4000,
                numsold: 0,
                url: "https://plati.market/itm/4904546",
                section_id: 20887
        },
        {
                name: "Marvel’s Spider-Man 2 (Человек Паук 2) PS5 | П2/П3",
                name_eng: "Marvel’s Spider-Man 2 PS5 | P2/P3",
                price_rur: 1090,
                numsold: 11,
                url: "https://plati.market/itm/5149327",
                section_id: 22380
        },
        {
                name: "MARVEL ЧЕЛОВЕК-ПАУК 2・DELUXE・ОНЛАЙН・АРЕНДА・STEAM・",
                name_eng: "MARVEL'S SPIDER-MAN 2・DELUXE・ONLINE・RENT・STEAM・",
                price_rur: 100,
                numsold: 0,
                url: "https://plati.market/itm/5345089",
                section_id: 22764
        },
        {
                name: "Marvel’s Spider-Man 2 Человек Паук 2 PS5/PS Турция/Украина",
                name_eng: "Marvel’s Spider-Man 2 PS5/PS Turkey/Ukraine",
                price_rur: 6611,
                numsold: 0,
                url: "https://plati.market/itm/5798316",
                section_id: 20887
        },
        {
                name: "Marvel’s Человек-Паук 2 улучшение до версии цифрового расширенного издания steam DLC",
                name_eng: "Marvel's Spider-Man 2 - Digital Deluxe Upgrade steam dlc steam",
                price_rur: 1500,
                numsold: 4,
                url: "https://plati.market/itm/5875584",
                section_id: 20887,
                description: "Апгрейд Standard издания до цифрового расширенного издания. <attention> Внимание- это DLC. Для запуска необходимо наличие Steam-версии игры Marvel's Spider-Man 2 </attention>"
        }
];

describe("M-PLATI: add-on and DLC filtering", () => {
    beforeEach(() => {
        jest.resetModules();
        global.fetch = jest.fn();
        jest.spyOn(console, "log").mockImplementation(() => undefined);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("skips the Deluxe upgrade DLC and returns the cheapest base-game key", async () => {
        const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: SPIDERMAN_ITEMS })));

        const { getPlatiCheapest } = await import("../lib/plati");
        const result = await getPlatiCheapest("Marvel Человек-Паук 2");

        expect(result?.priceRur).toBe(3850);
        expect(result?.url).toBe("https://plati.market/itm/4899317");
    });

    it("keeps a listing that merely bundles all DLC", async () => {
        const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            items: [
                { name: "Game Deluxe Edition [ВСЕ DLC] STEAM", price_rur: 700, numsold: 50, url: "/bundle", section_id: 20887 },
                { name: "Game Steam ключ", price_rur: 900, numsold: 40, url: "/base", section_id: 20887 },
            ],
        })));

        const { getPlatiCheapest } = await import("../lib/plati");
        const result = await getPlatiCheapest("Game");

        expect(result?.priceRur).toBe(700);
    });

    it("rejects an add-on that only the English title marks as an upgrade", async () => {
        const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            items: [
                { name: "Игра расширенное издание steam", name_eng: "Game Digital Deluxe Upgrade steam dlc", price_rur: 400, numsold: 50, url: "/upgrade", section_id: 20887 },
                { name: "Игра steam ключ", name_eng: "Game steam key", price_rur: 900, numsold: 40, url: "/base", section_id: 20887 },
            ],
        })));

        const { getPlatiCheapest } = await import("../lib/plati");
        const result = await getPlatiCheapest("Game");

        expect(result?.priceRur).toBe(900);
    });

    it("rejects an add-on that only the description declares as DLC", async () => {
        const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            items: [
                {
                    name: "Игра расширенное издание steam",
                    description: "Внимание- это DLC. Для запуска необходимо наличие Steam-версии игры",
                    price_rur: 400, numsold: 50, url: "/dlc", section_id: 20887,
                },
                { name: "Игра steam ключ", price_rur: 900, numsold: 40, url: "/base", section_id: 20887 },
            ],
        })));

        const { getPlatiCheapest } = await import("../lib/plati");
        const result = await getPlatiCheapest("Game");

        expect(result?.priceRur).toBe(900);
    });

    it("keeps a base-game listing whose description says DLC is not included", async () => {
        const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            items: [
                {
                    name: "Игра steam ключ",
                    description: "Стандартное издание. Без DLC, дополнения приобретаются отдельно",
                    price_rur: 400, numsold: 50, url: "/base", section_id: 20887,
                },
            ],
        })));

        const { getPlatiCheapest } = await import("../lib/plati");
        const result = await getPlatiCheapest("Game");

        expect(result?.priceRur).toBe(400);
    });
});
