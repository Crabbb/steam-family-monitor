// FILE: src/__tests__/core.test.ts
// VERSION: 1.0.0

import { formatGameMessage, formatDelistedGameMessage, formatRuUnavailableKzGameMessage } from "../lib/core";
import { SteamAppDetails } from "../lib/steam";

describe("M-CORE: Core Format Logic", () => {
    it("formatGameMessage should output HTML correctly with RU and KZ prices", () => {
        const detailsRu: SteamAppDetails = {
            name: "Cyberpunk 2077",
            price_overview: {
                final_formatted: "2000 ₽",
                final: 200000,
                discount_percent: 0
            },
            categories: [{ id: 2, description: "Single-player" }]
        };

        const detailsKz: SteamAppDetails = {
            name: "Cyberpunk 2077",
            price_overview: {
                final_formatted: "10000 ₸",
                final: 1000000,
                discount_percent: 0
            },
        };

        const html = formatGameMessage("User1", detailsRu, detailsKz, "platinum", "1091500", false, 2083);

        expect(html).toContain("🚨 <b>Новая игра у User1!</b>");
        expect(html).toContain("<b><a href=\"https://store.steampowered.com/app/1091500\">Cyberpunk 2077</a></b>");
        expect(html).toContain("💰 <b>Цена:</b> 2000 ₽ / ~2083 ₽ (10000 ₸)");
        expect(html).toContain("🎯 <b>Режимы:</b> Single-player");
        expect(html).toContain("🐧 <b>Steam Deck / Linux:</b> <a href=\"https://www.protondb.com/app/1091500\">Platinum</a>");
    });

    it("formatGameMessage should include [ТЕСТ] if isTest is true", () => {
        const details: SteamAppDetails = { name: "Fake Game" };
        const html = formatGameMessage("User2", details, null, null, "123", true);

        expect(html).toContain("<b>[ТЕСТ]</b>");
        expect(html).toContain("🚨 <b>Новая игра у User2!</b>");
    });

    it("formatGameMessage reports family library support from Steam categories", () => {
        const details: SteamAppDetails = {
            name: "Cyberpunk 2077",
            categories: [
                { id: 2, description: "Single-player" },
                { id: 62, description: "Family Sharing" },
            ],
        };

        const html = formatGameMessage("User1", details, null, null, "1091500", false);

        expect(html).toContain("Семейная библиотека:</b> Доступно");
    });

    it("formatGameMessage does not claim family library is unavailable when categories are missing", () => {
        const details: SteamAppDetails = { name: "Some Game" };

        const html = formatGameMessage("User1", details, null, null, "123", false);

        expect(html).toContain("Семейная библиотека:</b> Нет данных");
    });

    it("formatRuUnavailableKzGameMessage reports family library from KZ categories", () => {
        const detailsKz: SteamAppDetails = {
            name: "Cyberpunk 2077",
            categories: [{ id: 2, description: "Для одного игрока" }],
        };

        const html = formatRuUnavailableKzGameMessage("User1", detailsKz, null, "1091500", false);

        expect(html).toContain("Семейная библиотека:</b> Недоступно");
    });

    it("formatDelistedGameMessage should contain SteamDB link and warning", () => {
        const html = formatDelistedGameMessage("Стас", "Some Delisted Game", "1238860");

        expect(html).toContain("🚨 <b>Новая игра у Стас!</b>");
        expect(html).toContain("Some Delisted Game");
        expect(html).toContain("steamdb.info/app/1238860");
        expect(html).toContain("Информация об игре недоступна");
        expect(html).toContain("store.steampowered.com/app/1238860");
    });

    it("formatDelistedGameMessage should work with unknown app name", () => {
        const html = formatDelistedGameMessage("User1", "Unknown App 9999", "9999");

        expect(html).toContain("Unknown App 9999");
        expect(html).toContain("steamdb.info/app/9999");
    });
});
