// FILE: src/__tests__/telegramBot.commands.test.ts
// VERSION: 1.1.0

import { BOT_COMMANDS, buildHelpMessage, resolveCommand, formatStatusMessage } from "../lib/telegramBot";
import type { SettingsRow } from "../lib/jobRun";

jest.mock("../lib/db", () => ({
    prisma: {
        settings: { findUnique: jest.fn() },
        watchedGame: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), delete: jest.fn() },
    },
}));

// Default-shaped settings row (matches prisma/schema.prisma's @default values), cast through
// unknown since the real Settings type carries many unrelated required fields this test never needs.
function makeSettings(overrides: Record<string, unknown> = {}): SettingsRow {
    return {
        checkInterval: 15,
        watchlistIntervalHours: 12,
        freePromosIntervalHours: 1,
        freePromosStartHour: 9,
        freePromosEndHour: 23,
        achievementIntervalHours: 6,
        achievementStartHour: 9,
        achievementEndHour: 23,
        ...overrides,
    } as unknown as SettingsRow;
}

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

describe("M-TGBOT: formatStatusMessage", () => {
    it("formats the status message with one line per job", () => {
        const html = formatStatusMessage([
            { job: "library", startedAt: new Date(Date.now() - 5 * 60 * 1000), finishedAt: new Date(), ok: true, processed: 2, error: null },
            { job: "watchlist", startedAt: new Date(Date.now() - 40 * 60 * 1000), finishedAt: new Date(), ok: false, processed: 0, error: "Steam API error: 503" },
        ], makeSettings());

        expect(html).toContain("Библиотека");
        expect(html).toContain("✅");
        expect(html).toContain("Watchlist");
        expect(html).toContain("⚠️");
        expect(html).toContain("Steam API error: 503");
    });

    it("says plainly when a job has never run", () => {
        expect(formatStatusMessage([], makeSettings())).toContain("ни одного прогона");
    });

    it("marks a known job absent from the run list as never having run, distinct from a failure", () => {
        const html = formatStatusMessage([
            { job: "library", startedAt: new Date(), finishedAt: new Date(), ok: true, processed: 0, error: null },
        ], makeSettings());

        // free-promos and achievements never ran — they must still be listed, not silently
        // dropped, and must not be rendered as a failure (⚠️) or a success (✅).
        expect(html).toContain("Бесплатные раздачи");
        expect(html).toContain("Достижения");
        expect(html).not.toContain("Бесплатные раздачи</b> — 0 мин назад");
    });

    it("never displays the always-zero processed count", () => {
        const html = formatStatusMessage([
            { job: "library", startedAt: new Date(), finishedAt: new Date(), ok: true, processed: 0, error: null },
        ], makeSettings());

        expect(html).not.toMatch(/обработан/i);
    });

    it("renders an interrupted run (ok === null) as unresolved, not as success or failure", () => {
        const html = formatStatusMessage([
            { job: "library", startedAt: new Date(), finishedAt: null, ok: null, processed: 0, error: null },
        ], makeSettings());

        expect(html).toContain("⏳");
        expect(html).not.toContain("✅");
        expect(html).not.toContain("⚠️");
    });

    it("marks a job that has gone stale distinctly from a healthy one, not as ✅", () => {
        // library threshold is 3 * 15min = 45min by default; 50 minutes silent exceeds it, even
        // though its last run was ok. watchlist (threshold 3 * 12h = 36h) is fresh at 5 minutes.
        const html = formatStatusMessage([
            { job: "library", startedAt: new Date(Date.now() - 50 * 60 * 1000), finishedAt: new Date(), ok: true, processed: 0, error: null },
            { job: "watchlist", startedAt: new Date(Date.now() - 5 * 60 * 1000), finishedAt: new Date(), ok: true, processed: 0, error: null },
        ], makeSettings());

        const libraryLine = html.split("\n").find(line => line.includes("Библиотека"));
        const watchlistLine = html.split("\n").find(line => line.includes("Watchlist"));

        expect(libraryLine).toContain("💤");
        expect(libraryLine).not.toContain("✅");
        expect(watchlistLine).toContain("✅");
    });

    it("renders a disabled job as off rather than stale, no matter how long it has been silent", () => {
        // 200 hours would be well past watchlist's own 36h threshold if it were enabled.
        const html = formatStatusMessage([
            { job: "watchlist", startedAt: new Date(Date.now() - 200 * 60 * 60 * 1000), ok: true, finishedAt: new Date(), processed: 0, error: null },
        ], makeSettings({ watchlistEnabled: false }));

        const watchlistLine = html.split("\n").find(line => line.includes("Watchlist"));

        expect(watchlistLine).toContain("выключено");
        expect(watchlistLine).not.toContain("💤");
        expect(watchlistLine).not.toContain("✅");
    });
});
