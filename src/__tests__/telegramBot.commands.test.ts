// FILE: src/__tests__/telegramBot.commands.test.ts
// VERSION: 1.0.0

import { BOT_COMMANDS, buildHelpMessage, resolveCommand } from "../lib/telegramBot";

jest.mock("../lib/db", () => ({
    prisma: {
        settings: { findUnique: jest.fn() },
        watchedGame: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), delete: jest.fn() },
    },
}));

describe("M-TGBOT: command registry", () => {
    it("lists every registered command with its description in /help", () => {
        const help = buildHelpMessage();

        for (const spec of BOT_COMMANDS) {
            expect(help).toContain(`/${spec.name}`);
            expect(help).toContain(spec.description);
        }
    });

    it("documents the help command itself", () => {
        expect(buildHelpMessage()).toContain("/help");
    });

    it("documents every command the bot actually answers", () => {
        const names = BOT_COMMANDS.map(spec => spec.name);

        expect(names).toEqual(expect.arrayContaining(["price", "watch", "unwatch", "watchlist", "help"]));
    });

    it("resolves /start as an alias of /help", () => {
        expect(resolveCommand("start")).toBe(resolveCommand("help"));
    });

    it("resolves commands case-insensitively", () => {
        expect(resolveCommand("PRICE")?.name).toBe("price");
    });

    it("returns nothing for an unknown command", () => {
        expect(resolveCommand("definitely-not-a-command")).toBeUndefined();
    });
});
