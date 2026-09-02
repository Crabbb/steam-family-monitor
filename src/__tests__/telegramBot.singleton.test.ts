// FILE: src/__tests__/telegramBot.singleton.test.ts
// VERSION: 1.0.0

describe("M-TGBOT: singleton polling state", () => {
    beforeEach(() => {
        jest.resetModules();
        delete (globalThis as { steamMonitorTelegramBotState?: unknown }).steamMonitorTelegramBotState;
    });

    it("does not start a second polling loop when loaded through two module graphs", async () => {
        const settingsFindUnique = jest.fn().mockResolvedValue({ telegramToken: "token" });
        const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
        const releases: Array<() => void> = [];
        let fetchCallCount = 0;
        const fetchMock = jest.fn(() => new Promise(resolve => {
            fetchCallCount++;
            releases.push(() => resolve({
                json: async () => ({ ok: true, result: [] }),
            }));
        }));

        jest.doMock("../lib/db", () => ({
            prisma: {
                settings: { findUnique: settingsFindUnique },
                watchedGame: { findMany: jest.fn(), upsert: jest.fn(), delete: jest.fn() },
            },
        }));
        global.fetch = fetchMock as unknown as typeof fetch;

        let firstModule: typeof import("../lib/telegramBot") | null = null;
        let secondModule: typeof import("../lib/telegramBot") | null = null;
        let firstRun: Promise<void> | null = null;
        let secondRun: Promise<void> | null = null;

        try {
            firstModule = await import("../lib/telegramBot");
            firstRun = firstModule.startTelegramBot();
            await waitFor(() => fetchCallCount === 1);
            expect(fetchCallCount).toBe(1);

            jest.resetModules();
            secondModule = await import("../lib/telegramBot");
            secondRun = secondModule.startTelegramBot();
            await new Promise(resolve => setTimeout(resolve, 20));

            expect(fetchCallCount).toBe(1);
            expect(logSpy.mock.calls.filter(call => String(call[0]).includes("Starting long-polling"))).toHaveLength(1);
        } finally {
            firstModule?.stopTelegramBot();
            secondModule?.stopTelegramBot();
            releases.splice(0).forEach(release => release());
            await Promise.allSettled([firstRun, secondRun].filter((item): item is Promise<void> => item !== null));
            logSpy.mockRestore();
        }
    });
});

async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (condition()) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
}
