// FILE: src/__tests__/steamHttp.test.ts
// VERSION: 1.0.0

import { resetSteamHttpState, steamFetchJson, steamFetchText, steamHttpStats } from "../lib/steamHttp";

global.fetch = jest.fn();

function okJson(body: object) {
    return { ok: true, status: 200, json: async () => body };
}

function failure(status: number) {
    return { ok: false, status, statusText: `status ${status}`, text: async () => "{}", json: async () => ({}) };
}

describe("M-STEAMHTTP: single door to Steam", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        resetSteamHttpState();
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it("returns parsed json for a successful request", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce(okJson({ hello: "world" }));

        const data = await steamFetchJson<{ hello: string }>("https://store.steampowered.com/api/appdetails?appids=1");

        expect(data).toEqual({ hello: "world" });
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("serves a second identical request from cache within the TTL", async () => {
        (global.fetch as jest.Mock).mockResolvedValue(okJson({ n: 1 }));
        const url = "https://store.steampowered.com/api/appdetails?appids=220&cc=ru";

        const first = await steamFetchJson(url, { cacheTtlMs: 600_000 });
        const second = await steamFetchJson(url, { cacheTtlMs: 600_000 });

        expect(first).toEqual(second);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(steamHttpStats().cacheHits).toBe(1);
    });

    it("refetches after the TTL expires", async () => {
        jest.useFakeTimers();
        (global.fetch as jest.Mock).mockResolvedValue(okJson({ n: 1 }));
        const url = "https://store.steampowered.com/api/appdetails?appids=220&cc=ru";

        await steamFetchJson(url, { cacheTtlMs: 1000 });
        await jest.advanceTimersByTimeAsync(1500);
        await steamFetchJson(url, { cacheTtlMs: 1000 });

        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("does not cache when no TTL is given", async () => {
        (global.fetch as jest.Mock).mockResolvedValue(okJson({ n: 1 }));

        await steamFetchJson("https://api.steampowered.com/x");
        await steamFetchJson("https://api.steampowered.com/x");

        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("retries a 429 and returns the eventual success", async () => {
        jest.useFakeTimers();
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(failure(429))
            .mockResolvedValueOnce(okJson({ ok: true }));

        const pending = steamFetchJson("https://store.steampowered.com/api/appdetails?appids=2");
        await jest.advanceTimersByTimeAsync(2000);
        const data = await pending;

        expect(data).toEqual({ ok: true });
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(steamHttpStats().retries).toBe(1);
    });

    it("gives up after three attempts and returns null", async () => {
        jest.useFakeTimers();
        (global.fetch as jest.Mock).mockResolvedValue(failure(503));

        const pending = steamFetchJson("https://store.steampowered.com/api/appdetails?appids=3");
        await jest.advanceTimersByTimeAsync(1500);
        const data = await pending;

        expect(data).toBeNull();
        expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it("does not retry a 404", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce(failure(404));

        const data = await steamFetchJson("https://store.steampowered.com/api/appdetails?appids=4");

        expect(data).toBeNull();
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("redacts the Steam API key from a URL before logging a failure", async () => {
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        (global.fetch as jest.Mock).mockResolvedValueOnce(failure(404));

        await steamFetchJson(
            "https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/?key=SECRET123&steamid=765611980",
        );

        const logged = warnSpy.mock.calls.map(call => call.join(" ")).join("\n");
        expect(logged).not.toContain("SECRET123");
        expect(logged).not.toContain("key=SECRET");
        expect(logged).toContain("GetPlayerAchievements");
        expect(logged).toContain("key=***");
    });

    it("falls back to origin+path (no query at all) when the URL can't be parsed", async () => {
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        (global.fetch as jest.Mock).mockResolvedValueOnce(failure(404));

        await steamFetchJson("not-a-url?key=SECRET123");

        const logged = warnSpy.mock.calls.map(call => call.join(" ")).join("\n");
        expect(logged).not.toContain("SECRET123");
        expect(logged).not.toContain("?");
    });

    it("calls onHttpError instead of the generic warning for a non-retryable status, and still returns null", async () => {
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: false,
            status: 403,
            statusText: "Forbidden",
            text: async () => JSON.stringify({ error: "Profile is not public" }),
            json: async () => ({}),
        });
        const onHttpError = jest.fn();

        const data = await steamFetchJson("https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/?appid=1", {
            onHttpError,
        });

        expect(data).toBeNull();
        expect(onHttpError).toHaveBeenCalledWith(403, JSON.stringify({ error: "Profile is not public" }));
        expect(warnSpy).not.toHaveBeenCalled();
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("passes null to onHttpError when the failure body cannot be read", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => { throw new Error("body already consumed"); },
            json: async () => ({}),
        });
        const onHttpError = jest.fn();

        const data = await steamFetchJson("https://api.steampowered.com/x?appid=1", { onHttpError });

        expect(data).toBeNull();
        expect(onHttpError).toHaveBeenCalledWith(400, null);
    });

    it("still uses the gateway's own generic warning for a retryable status even when onHttpError is supplied", async () => {
        jest.useFakeTimers();
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        (global.fetch as jest.Mock).mockResolvedValue(failure(503));
        const onHttpError = jest.fn();

        const pending = steamFetchJson("https://api.steampowered.com/x?appid=1", { onHttpError });
        await jest.advanceTimersByTimeAsync(1500);
        const data = await pending;

        expect(data).toBeNull();
        expect(onHttpError).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
    });

    it("retries a network error and returns the eventual success", async () => {
        jest.useFakeTimers();
        (global.fetch as jest.Mock)
            .mockRejectedValueOnce(new Error("network down"))
            .mockResolvedValueOnce(okJson({ ok: true }));

        const pending = steamFetchJson("https://store.steampowered.com/api/appdetails?appids=5");
        await jest.advanceTimersByTimeAsync(500);
        const data = await pending;

        expect(data).toEqual({ ok: true });
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(steamHttpStats().retries).toBe(1);
    });

    it("gives up after three attempts of a persistent network error and returns null", async () => {
        jest.useFakeTimers();
        (global.fetch as jest.Mock).mockRejectedValue(new Error("network down"));

        const pending = steamFetchJson("https://store.steampowered.com/api/appdetails?appids=6");
        await jest.advanceTimersByTimeAsync(1500);
        const data = await pending;

        expect(data).toBeNull();
        expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it("serializes concurrent callers instead of only delaying the first", async () => {
        jest.useFakeTimers();
        const previousInterval = process.env.STEAM_MIN_INTERVAL_MS;
        process.env.STEAM_MIN_INTERVAL_MS = "100";
        (global.fetch as jest.Mock).mockImplementation(async () => okJson({ n: 1 }));

        // Three callers fire together (no await between them), the way a Promise.all batch
        // of achievement lookups does. Each must wait for its own turn, not just read the
        // same stale "last request" timestamp the other two also read.
        const pending = Promise.all([
            steamFetchJson("https://api.steampowered.com/a"),
            steamFetchJson("https://api.steampowered.com/b"),
            steamFetchJson("https://api.steampowered.com/c"),
        ]);

        await jest.advanceTimersByTimeAsync(0);
        expect(global.fetch).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(100);
        expect(global.fetch).toHaveBeenCalledTimes(2);

        await jest.advanceTimersByTimeAsync(100);
        expect(global.fetch).toHaveBeenCalledTimes(3);

        await pending;
        process.env.STEAM_MIN_INTERVAL_MS = previousInterval;
    });
});

describe("M-STEAMHTTP: steamFetchText for HTML endpoints", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        resetSteamHttpState();
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it("returns the raw body text for a successful request", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => "<html>search results</html>",
        });

        const body = await steamFetchText("https://store.steampowered.com/search/results/?cc=ru");

        expect(body).toBe("<html>search results</html>");
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("gives up after three attempts of persistent 503s and returns null", async () => {
        jest.useFakeTimers();
        (global.fetch as jest.Mock).mockResolvedValue(failure(503));

        const pending = steamFetchText("https://store.steampowered.com/search/results/?cc=ru");
        await jest.advanceTimersByTimeAsync(1500);
        const body = await pending;

        expect(body).toBeNull();
        expect(global.fetch).toHaveBeenCalledTimes(3);
    });
});
