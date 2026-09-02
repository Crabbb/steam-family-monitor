// FILE: src/__tests__/steam.cache.test.ts
// VERSION: 1.1.0

import { getAppDetails } from "../lib/steam";
import { resetSteamHttpState, steamHttpStats } from "../lib/steamHttp";

global.fetch = jest.fn();

describe("M-STEAM: appdetails caching", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        resetSteamHttpState();
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it("asks Steam once for the same app and region", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ "220": { success: true, data: { name: "Half-Life 2" } } }),
        });

        const first = await getAppDetails("220", "ru");
        const second = await getAppDetails("220", "ru");

        expect(first?.name).toBe("Half-Life 2");
        expect(second?.name).toBe("Half-Life 2");
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(steamHttpStats().cacheHits).toBe(1);
    });

    it("does not cache a negative body even though Steam answered with HTTP 200", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ "220": { success: false } }),
        });

        const first = await getAppDetails("220", "ru");
        const second = await getAppDetails("220", "ru");

        expect(first).toBeNull();
        expect(second).toBeNull();
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(steamHttpStats().cacheHits).toBe(0);
    });

    it("keeps regions apart", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ "220": { success: true, data: { name: "Half-Life 2" } } }),
        });

        await getAppDetails("220", "ru");
        await getAppDetails("220", "kz");

        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("returns null without throwing when Steam keeps failing", async () => {
        jest.useFakeTimers();
        (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 503, statusText: "unavailable", json: async () => ({}) });

        const pending = getAppDetails("220", "ru");
        await jest.advanceTimersByTimeAsync(1500);
        const details = await pending;

        expect(details).toBeNull();
    });
});
